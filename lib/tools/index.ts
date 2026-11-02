import { z } from "zod";
import { toInputSchema } from "@/lib/agent/schemas";
import { evidenceTools } from "./evidenceTools";
import { stateTools } from "./stateTools";
import type { AgentTool, ToolContext, ToolOutput } from "./types";
import type { ToolSpec } from "@/lib/llm";

export const ALL_TOOLS: AgentTool[] = [...evidenceTools, ...stateTools] as AgentTool[];
const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Provider-neutral tool specs; each LLM adapter translates them to its own format. */
export function toolSpecs(): ToolSpec[] {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toInputSchema(t.schema),
  }));
}

/** Validate the model's tool input with zod, then run the tool. Never throws. */
export function executeTool(name: string, rawInput: unknown, ctx: ToolContext): ToolOutput {
  const tool = BY_NAME.get(name);
  if (!tool) return { result: { error: `Unknown tool ${name}` }, summary: `unknown tool ${name}`, isError: true };
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      result: { error: "Invalid input", issues: z.prettifyError(parsed.error) },
      summary: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 200)}`,
      isError: true,
    };
  }
  try {
    return tool.run(parsed.data, ctx);
  } catch (err) {
    return { result: { error: `Tool failed: ${(err as Error).message}` }, summary: `tool error: ${(err as Error).message}`, isError: true };
  }
}

export type { ToolContext, ToolOutput } from "./types";
