import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SvgConverter } from "../svg-trajectory-converter/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create server instance
const server = new McpServer({
  name: "cutterprod-mcp",
  version: "1.0.0",
});

// Tool 1: Parametric Box Generator
server.tool(
  "generate_parametric_svg",
  "Generates an SVG template for a foldable box with creases and cuts, ready for CutterProd.",
  {
    width: z.number().describe("Width of the base in mm"),
    height: z.number().describe("Height of the base in mm"),
    depth: z.number().describe("Depth of the box sides in mm"),
    filename: z.string().describe("Filename to save the SVG as (e.g. box.svg)")
  },
  async ({ width, height, depth, filename }) => {
    const totalW = width + 2 * depth;
    const totalH = height + 2 * depth;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}mm" height="${totalH}mm">
  <!-- Inner Crease Lines -->
  <path data-method="crease" stroke="#f59e0b" stroke-width="2" fill="none" d="
    M ${depth} ${depth} L ${depth+width} ${depth}
    M ${depth} ${depth+height} L ${depth+width} ${depth+height}
    M ${depth} ${depth} L ${depth} ${depth+height}
    M ${depth+width} ${depth} L ${depth+width} ${depth+height}
  "/>
  
  <!-- Outer Thru-Cut Outline -->
  <path data-method="thru_cut" stroke="#3b82f6" stroke-width="2" fill="none" d="
    M ${depth} 0 
    L ${depth+width} 0 
    L ${depth+width} ${depth} 
    L ${depth+width+depth} ${depth} 
    L ${depth+width+depth} ${depth+height} 
    L ${depth+width} ${depth+height} 
    L ${depth+width} ${totalH} 
    L ${depth} ${totalH} 
    L ${depth} ${depth+height} 
    L 0 ${depth+height} 
    L 0 ${depth} 
    L ${depth} ${depth} 
    Z
  "/>
</svg>`;

    const savePath = path.join(__dirname, "..", "src", filename);
    fs.writeFileSync(savePath, svg);

    return {
      content: [{ type: "text", text: `Successfully generated ${filename} with dimensions ${totalW}x${totalH}mm and saved to ${savePath}. You can view it in the CutterProd interface by loading it.` }]
    };
  }
);

// Tool 2: Converter & Estimator
server.tool(
  "convert_and_estimate_svg",
  "Parses an SVG file, generates machine trajectory packets using SvgConverter, and estimates cutting time and travel distance.",
  {
    svgContent: z.string().describe("The raw SVG XML content to parse.")
  },
  async ({ svgContent }) => {
    try {
      // For Node environment, SvgConverter DOM parsing falls back to regex if DOMParser isn't available
      // It handles it automatically.
      const converter = new SvgConverter({ 
        feedRate: 300, 
        stepsPerMM_X: 160, 
        stepsPerMM_Y: 160, 
        stepsPerMM_Z: 80 
      });
      
      const { preamble, packets } = converter.convert(svgContent);

      let totalDistMm = 0;
      let creaseMoves = 0;
      let cutMoves = 0;

      for (const pkt of packets) {
        if (pkt.length < 22) continue;
        const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
        const dx = Math.abs(view.getInt32(1, true)) / 160;
        const dy = Math.abs(view.getInt32(5, true)) / 160;
        
        const dist = Math.hypot(dx, dy);
        totalDistMm += dist;

        // Approximation of move type based on height isn't fully possible here without deeper packet inspection
        // We'll just count total packets
      }

      // 300 mm/min = 5 mm/sec
      const estimatedTimeSec = totalDistMm / 5;
      const mins = Math.floor(estimatedTimeSec / 60);
      const secs = Math.round(estimatedTimeSec % 60);

      const report = `
📊 Trajectory Estimation Report
--------------------------------
Total MicroSegments : ${packets.length}
Total Travel Distance: ${totalDistMm.toFixed(2)} mm
Estimated Cut Time   : ${mins}m ${secs}s (at 300mm/min)
Preamble Commands    : ${preamble.length}
`;

      return {
        content: [{ type: "text", text: report }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error processing SVG: ${err.message}` }]
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CutterProd MCP Server running on stdio");
}

main().catch(err => {
  console.error("Fatal Error in MCP Server:", err);
  process.exit(1);
});
