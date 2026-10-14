import { z } from "zod";

/** Severity enum reused for structured LLM output. */
const SeveritySchema = z.enum(["ok", "info", "warning", "critical"]);

/**
 * Structured-output schema for the correlate_and_rank node. The LLM must
 * return exactly this shape (enforced via withStructuredOutput), which keeps
 * the narration grounded and machine-consumable. The model references existing
 * findings by checkId — it cannot fabricate new findings or metrics.
 */
export const HealthAnalysisSchema = z.object({
  summary: z
    .string()
    .describe(
      "One concise paragraph (<= 80 words) summarizing the deployment's health for a dashboard header. State the overall posture and the single most important risk.",
    ),
  topRisks: z
    .array(
      z.object({
        title: z.string().describe("Short risk title."),
        severity: SeveritySchema,
        relatedCheckIds: z
          .array(z.string())
          .describe(
            "checkIds of the provided findings that this risk correlates. Must only use checkIds present in the input.",
          ),
        rationale: z
          .string()
          .describe("Why this matters, referencing the evidence numbers provided."),
      }),
    )
    .describe("Top risks ordered most-severe first. Correlate related findings into one risk where sensible.")
    .max(6),
  recommendations: z
    .array(z.string())
    .describe("Actionable next steps, highest impact first.")
    .max(6),
});

export type HealthAnalysisOutput = z.infer<typeof HealthAnalysisSchema>;
