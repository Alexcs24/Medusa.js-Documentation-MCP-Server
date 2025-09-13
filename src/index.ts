#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Fuse from "fuse.js";

// Load configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = join(__dirname, "..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));


interface DocSection {
  title: string;
  content: string;
  url?: string;
  category?: string;
  path?: string;
}

class MedusaDocsServer {
  private server: Server;
  private documentation: string = "";
  private sections: DocSection[] = [];
  private fuse: Fuse<DocSection> | null = null;
  private docsPath: string;

  constructor() {
    this.server = new Server(
      {
        name: config.server.name,
        version: config.server.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Try multiple paths for the documentation file
    const possiblePaths = [
      process.env.MEDUSA_DOCS_PATH || "",
      ...config.documentation.fallbackPaths.map((path: string) =>
        path.startsWith('/') ? path : join(process.cwd(), path)
      ),
    ].filter(Boolean);

    // Find the first existing path
    this.docsPath = possiblePaths.find(path => existsSync(path)) || "";
    
    if (!this.docsPath) {
      console.error("Documentation file not found. Tried paths:", possiblePaths);
      console.error("Please set MEDUSA_DOCS_PATH environment variable or place llms-full.txt in the project directory");
    } else {
      console.error(`Loading documentation from: ${this.docsPath}`);
      this.loadDocumentation();
    }

    this.setupHandlers();
  }

  private loadDocumentation() {
    try {
      this.documentation = readFileSync(this.docsPath, "utf-8");
      this.parseSections();
      this.initializeSearch();
      console.error(`Successfully loaded documentation: ${this.sections.length} sections parsed`);
    } catch (error) {
      console.error("Error loading documentation:", error);
      this.documentation = "";
    }
  }

  private parseSections() {
    // Parse the documentation into sections
    const lines = this.documentation.split("\n");
    let currentSection: DocSection | null = null;
    let contentBuffer: string[] = [];

    for (const line of lines) {
      // Check for main headers (# ...)
      if (line.startsWith("# ") && !line.startsWith("## ") && !line.startsWith("### ")) {
        if (currentSection && contentBuffer.length > 0) {
          currentSection.content = contentBuffer.join("\n").trim();
          this.sections.push(currentSection);
        }

        currentSection = {
          title: line.replace("# ", "").trim(),
          content: "",
          path: line.replace("# ", "").replace(/\s+/g, "_").toLowerCase(),
        };
        contentBuffer = [];
      }
      // Check for section headers (## ...)
      else if (line.startsWith("## ") && currentSection) {
        if (contentBuffer.length > 0) {
          const subSection: DocSection = {
            title: `${currentSection.title} | ${line.replace("## ", "").trim()}`,
            content: contentBuffer.join("\n").trim(),
            path: currentSection.path,
          };
          if (subSection.content) {
            this.sections.push(subSection);
          }
        }
        contentBuffer = [line];
      } else if (currentSection) {
        contentBuffer.push(line);
      }
    }

    // Add the last section
    if (currentSection && contentBuffer.length > 0) {
      currentSection.content = contentBuffer.join("\n").trim();
      this.sections.push(currentSection);
    }
  }

  private initializeSearch() {
    this.fuse = new Fuse(this.sections, {
      keys: ["title", "content", "path"],
      threshold: config.searchDefaults.threshold,
      includeScore: true,
      minMatchCharLength: config.searchDefaults.minMatchCharLength,
      shouldSort: true,
      findAllMatches: false,
      ignoreLocation: true,
    });
  }

  private setupHandlers() {
    // Handle list tools request
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_docs",
          description: "Search Medusa.js documentation for specific topics",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query for finding relevant documentation",
              },
              limit: {
                type: "number",
                description: `Maximum number of results to return (default: ${config.searchDefaults.maxResults})`,
                default: config.searchDefaults.maxResults,
              },
            },
            required: ["query"],
          },
        } as Tool,
        {
          name: "get_section",
          description: "Get a specific documentation section by title or path",
          inputSchema: {
            type: "object",
            properties: {
              identifier: {
                type: "string",
                description: "Section title or path to retrieve",
              },
            },
            required: ["identifier"],
          },
        } as Tool,
        {
          name: "list_sections",
          description: "List all available documentation sections",
          inputSchema: {
            type: "object",
            properties: {
              category: {
                type: "string",
                description: "Filter sections by category (optional)",
              },
            },
          },
        } as Tool,
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "search_docs": {
          const query = args?.query as string;
          const limit = (args?.limit as number) || config.searchDefaults.maxResults;

          if (!this.fuse) {
            return {
              content: [
                {
                  type: "text",
                  text: "Documentation not loaded. Please check the file path.",
                },
              ],
            };
          }

          const results = this.fuse.search(query, { limit });
          
          if (results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No results found for query: "${query}"`,
                },
              ],
            };
          }

          const formattedResults = results.map((result, index) => {
            const { title, content } = result.item;
            const preview = content.substring(0, config.documentation.previewLength) + (content.length > config.documentation.previewLength ? "..." : "");
            return `${index + 1}. **${title}**\n${preview}\n`;
          }).join("\n---\n");

          return {
            content: [
              {
                type: "text",
                text: formattedResults,
              },
            ],
          };
        }

        case "get_section": {
          const identifier = args?.identifier as string;
          
          const section = this.sections.find(
            s => s.title.toLowerCase().includes(identifier.toLowerCase()) ||
                 (s.path && s.path.toLowerCase().includes(identifier.toLowerCase()))
          );

          if (!section) {
            return {
              content: [
                {
                  type: "text",
                  text: `Section not found: "${identifier}"`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `# ${section.title}\n\n${section.content}`,
              },
            ],
          };
        }

        case "list_sections": {
          const category = args?.category as string | undefined;
          
          let filteredSections = this.sections;
          if (category) {
            filteredSections = this.sections.filter(s => 
              s.path?.toLowerCase().includes(category.toLowerCase()) ||
              s.title.toLowerCase().includes(category.toLowerCase())
            );
          }

          const sectionList = filteredSections
            .slice(0, config.listDefaults.maxSections)
            .map(s => `- ${s.title}`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Available sections${category ? ` (filtered by: ${category})` : ""}:\n\n${sectionList}\n\nTotal: ${filteredSections.length} sections`,
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown tool: ${name}`,
              },
            ],
          };
      }
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Medusa Docs MCP Server running on stdio");
  }
}

// Start the server
const server = new MedusaDocsServer();
server.start().catch(console.error);
