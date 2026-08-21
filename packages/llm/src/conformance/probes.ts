// Model conformance probes — confront ONE model with the contracts this
// product actually depends on, and report what it really does.
//
// Why this exists
// ---------------
// The audit of 2026-08-07 could only characterise 1 of the 12 provider harnesses
// (AUDIT_HARNESSES.md is mostly BLOCKED), and the answer would have gone stale
// anyway: providers drift, models get added, and `CAPABILITY_MATRIX` is a set of
// CLAIMS nothing ever checked against reality. A one-off audit document cannot
// keep up with that. A suite can.
//
// So the deliverable is not "here is what GLM 5.2 does" — it is "here is how you
// find out, for any model, in three minutes". Adding a model to the catalogue
// should mean running this against it and reading the table.
//
// Scope, honestly stated
// ----------------------
// A probe exercises a HARNESS CODE PATH, not a brand. Running GLM 5.2 through
// OpenRouter exercises `providers/openrouter.ts`; it says nothing about
// `providers/deepseek.ts`. Every result carries the harness it went through, so
// a matrix of "11 harnesses" is only complete when each has been driven with its
// own native credentials.
//
// Cost: every probe uses a minimal prompt and caps output. A full run against a
// cheap model costs on the order of a cent.

import { z } from 'zod';
import { tool } from 'ai';
import type { NodalLlmClient, ProviderCapabilities } from '../types.ts';

export type ProbeStatus =
  /** The contract holds. */
  | 'pass'
  /** The contract does NOT hold — the harness or the model misbehaves. */
  | 'fail'
  /** The model legitimately does not offer this; not a defect. */
  | 'unsupported'
  /** The probe could not reach a verdict (network, quota, timeout). */
  | 'inconclusive';

export interface ProbeResult {
  id: string;
  label: string;
  status: ProbeStatus;
  /** One line a human can act on. Never "ok"/"ko" alone. */
  detail: string;
  /** Raw numbers behind the verdict, for the report and for diffing runs. */
  evidence?: Record<string, unknown>;
}

export interface ProbeContext {
  client: NodalLlmClient;
  /** What CAPABILITY_MATRIX claims for this provider — probes compare against it. */
  declared: ProviderCapabilities;
}

export interface Probe {
  id: string;
  label: string;
  /** Skip when the matrix already says the provider does not offer this. */
  requires?: keyof ProviderCapabilities;
  run: (ctx: ProbeContext) => Promise<ProbeResult>;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function ok(
  id: string,
  label: string,
  detail: string,
  evidence?: Record<string, unknown>,
): ProbeResult {
  return { id, label, status: 'pass', detail, evidence };
}
function ko(
  id: string,
  label: string,
  detail: string,
  evidence?: Record<string, unknown>,
): ProbeResult {
  return { id, label, status: 'fail', detail, evidence };
}
function meh(
  id: string,
  label: string,
  detail: string,
  evidence?: Record<string, unknown>,
): ProbeResult {
  return { id, label, status: 'inconclusive', detail, evidence };
}

/** Usage fields the AI SDK exposes, narrowed defensively — providers omit some. */
interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

function usageOf(result: unknown): UsageLike {
  const u = (result as { usage?: UsageLike }).usage;
  return u ?? {};
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * True when a failure is about the ACCOUNT, not the model.
 *
 * A dead key, an empty balance or a rate limit makes every probe fail, and
 * reporting those as `fail` accuses the model of not supporting tool calls when
 * the real problem is billing. Same misattribution the suite exists to avoid:
 * a red table must mean "this model misbehaves", never "your key is wrong".
 */
function isEnvironmentFailure(msg: string): boolean {
  return /credit balance|quota|insufficient|billing|payment|unauthor|authentication|invalid[_ ]api[_ ]key|forbidden|rate.?limit|429|401|402|403/i.test(
    msg,
  );
}

/** Verdict for a caught error: environmental → inconclusive, else a real failure. */
function verdict(
  id: string,
  label: string,
  e: unknown,
  evidence?: Record<string, unknown>,
): ProbeResult {
  const msg = errMessage(e);
  return isEnvironmentFailure(msg)
    ? {
        id,
        label,
        status: 'inconclusive',
        detail: `Problème de compte, pas de modèle: ${msg.slice(0, 140)}`,
        ...(evidence ? { evidence } : {}),
      }
    : ko(id, label, msg.slice(0, 200), evidence);
}

/** The one tool every tool-calling probe declares. Deliberately trivial: the
 *  point is the CALL MECHANICS, not the model's reasoning. */
const weatherTool = tool({
  description: 'Return the current temperature for a city.',
  inputSchema: z.object({
    city: z.string().describe('City name, e.g. "Lyon"'),
  }),
});

// ─── probes ───────────────────────────────────────────────────────────────────

/**
 * The floor. If this fails nothing else means anything, and the failure message
 * is the single most useful output of the whole run (bad key, unknown model id,
 * wrong base URL all surface here).
 */
export const basicCompletion: Probe = {
  id: 'basic-completion',
  label: 'Répond à un prompt simple',
  async run({ client }) {
    try {
      // Budget deliberately generous: on a REASONING model the whole output
      // allowance can be consumed by chain-of-thought before a single visible
      // token is emitted, and a tight cap makes a healthy model look broken.
      // Measured on GLM 5.2: maxOutputTokens=16 → 64 tokens billed, text empty.
      const res = await client.generateText({
        prompt: 'Réponds exactement: OK',
        maxOutputTokens: 512,
      });
      const text = (res.text ?? '').trim();
      if (text.length === 0) {
        const u = usageOf(res);
        // Distinguish "produced nothing" from "spent it all on reasoning" —
        // the second is a budgeting fact about the model, not a broken harness.
        const detail =
          (u.reasoningTokens ?? 0) > 0
            ? `Texte vide alors que ${u.reasoningTokens} tokens de raisonnement ont été facturés — ` +
              `le budget de sortie part entièrement dans le raisonnement.`
            : 'Réponse vide — le modèle répond mais ne produit aucun texte.';
        return ko(this.id, this.label, detail, { usage: u });
      }
      return ok(this.id, this.label, `A répondu (${text.slice(0, 40)})`, {
        usage: usageOf(res),
      });
    } catch (e) {
      return verdict(this.id, this.label, e);
    }
  },
};

/**
 * Usage accounting. The runner's token budget (Guard 1a) and the cost cap both
 * read these — a provider that omits them silently disables both guards.
 */
export const usageAccounting: Probe = {
  id: 'usage-accounting',
  label: 'Remonte inputTokens / outputTokens',
  async run({ client }) {
    try {
      const res = await client.generateText({
        prompt: 'Compte de 1 à 5.',
        maxOutputTokens: 64,
      });
      const u = usageOf(res);
      if (!u.inputTokens || !u.outputTokens) {
        return ko(
          this.id,
          this.label,
          'Tokens absents ou nuls — le garde-fou de budget et le plafond de coût sont aveugles sur ce modèle.',
          { usage: u },
        );
      }
      return ok(this.id, this.label, `in=${u.inputTokens} out=${u.outputTokens}`, { usage: u });
    } catch (e) {
      return meh(this.id, this.label, errMessage(e).slice(0, 200));
    }
  },
};

/**
 * Tool calling, single turn. The runner is a tool loop — a model that cannot
 * emit a well-formed call is unusable here whatever else it does well.
 */
export const toolCallSingle: Probe = {
  id: 'tool-call-single',
  label: 'Émet un appel d’outil bien formé',
  requires: 'toolUse',
  async run({ client }) {
    try {
      const res = await client.generateText({
        prompt: 'Quelle température fait-il à Lyon ? Utilise l’outil.',
        tools: { get_weather: weatherTool },
        maxOutputTokens: 256,
      });
      const calls = res.toolCalls ?? [];
      if (calls.length === 0) {
        return ko(
          this.id,
          this.label,
          'Aucun appel d’outil émis alors que la tâche l’exigeait — le modèle ignore les outils déclarés.',
          { finishReason: res.finishReason, text: (res.text ?? '').slice(0, 120) },
        );
      }
      const call = calls[0] as { toolName?: string; input?: unknown };
      const input = call.input as { city?: unknown } | undefined;
      if (call.toolName !== 'get_weather') {
        return ko(this.id, this.label, `Outil inattendu: ${String(call.toolName)}`);
      }
      if (typeof input?.city !== 'string') {
        return ko(
          this.id,
          this.label,
          `Arguments mal typés: city=${typeof input?.city} (le schéma exige une chaîne)`,
          { input },
        );
      }
      return ok(this.id, this.label, `get_weather(city="${input.city}")`, {
        calls: calls.length,
      });
    } catch (e) {
      return verdict(this.id, this.label, e);
    }
  },
};

/**
 * Tool calling, full round trip: call → result → final answer.
 *
 * This is the contract the runner actually depends on, and the one that breaks
 * on weaker models: they emit a call, then cannot consume the result and either
 * re-call in a loop or answer as if the tool had never run.
 */
export const toolCallRoundTrip: Probe = {
  id: 'tool-call-roundtrip',
  label: 'Consomme un résultat d’outil et conclut',
  requires: 'toolUse',
  async run({ client }) {
    try {
      const res = await client.generateText({
        messages: [
          { role: 'user', content: 'Quelle température fait-il à Lyon ? Utilise l’outil.' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_1',
                toolName: 'get_weather',
                input: { city: 'Lyon' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call_1',
                toolName: 'get_weather',
                output: { type: 'json', value: { celsius: 21 } },
              },
            ],
          },
        ],
        tools: { get_weather: weatherTool },
        maxOutputTokens: 128,
      });
      const text = (res.text ?? '').trim();
      if (text.length === 0) {
        return ko(
          this.id,
          this.label,
          'Aucune réponse finale après le résultat d’outil — le modèle ne referme pas la boucle.',
          { finishReason: res.finishReason, toolCalls: (res.toolCalls ?? []).length },
        );
      }
      const usesResult = /21/.test(text);
      return usesResult
        ? ok(this.id, this.label, `Réponse finale exploitant le résultat: "${text.slice(0, 60)}"`)
        : ko(
            this.id,
            this.label,
            `A répondu sans reprendre la valeur du résultat (21): "${text.slice(0, 80)}"`,
          );
    } catch (e) {
      return verdict(this.id, this.label, e);
    }
  },
};

/** Streaming. Declared per provider; verified here rather than trusted. */
export const streaming: Probe = {
  id: 'streaming',
  label: 'Diffuse la réponse en flux',
  requires: 'streaming',
  async run({ client }) {
    try {
      // Same reasoning-budget trap as basic-completion, plus one of its own:
      // `textStream` yields TEXT parts only, so a reasoning model streaming its
      // chain-of-thought first looks silent. `fullStream` is read alongside so a
      // silent textStream can be told apart from a genuinely empty response.
      const res = client.streamText({ prompt: 'Compte de 1 à 10.', maxOutputTokens: 512 });
      let chunks = 0;
      let otherParts = 0;
      let text = '';
      let streamError: unknown = null;
      for await (const part of res.fullStream) {
        if (part.type === 'text-delta') {
          chunks += 1;
          text += (part as { text?: string }).text ?? '';
        } else if (part.type === 'error') {
          // A stream does not THROW on an API failure — it emits an error part.
          // Without this the probe reports "no text chunks" and blames the
          // model for what is a dead key or an empty balance.
          streamError = (part as { error?: unknown }).error;
          otherParts += 1;
        } else {
          otherParts += 1;
        }
        if (chunks + otherParts > 400) break;
      }
      if (streamError !== null && chunks === 0) {
        return verdict(this.id, this.label, streamError, { textChunks: 0, otherParts });
      }
      if (chunks === 0) {
        return ko(
          this.id,
          this.label,
          otherParts > 0
            ? `Aucun chunk de TEXTE, mais ${otherParts} autres événements de flux — ` +
                `le modèle diffuse (raisonnement, appels d'outils) sans jamais émettre de texte.`
            : 'Aucun événement reçu — le flux est entièrement vide.',
          { textChunks: chunks, otherParts },
        );
      }
      // One chunk means the provider buffered the whole answer: technically a
      // stream, practically not one.
      return chunks === 1
        ? ko(this.id, this.label, 'Un seul chunk — réponse bufferisée, pas un vrai flux.', {
            chunks,
            otherParts,
          })
        : ok(this.id, this.label, `${chunks} chunks de texte`, {
            chunks,
            otherParts,
            chars: text.length,
          });
    } catch (e) {
      return verdict(this.id, this.label, e);
    }
  },
};

/** Structured output against a real schema. */
export const structuredOutput: Probe = {
  id: 'structured-output',
  label: 'Produit un objet conforme à un schéma',
  requires: 'structuredOutputs',
  async run({ client }) {
    try {
      // `output: 'object'` must be explicit: the AI SDK's overloads make
      // `schema` ambiguous without it once the model arg is omitted.
      const res = await client.generateObject({
        output: 'object',
        schema: z.object({ city: z.string(), celsius: z.number() }),
        prompt: 'Lyon fait 21 degrés. Renvoie-le en objet.',
      } as Parameters<typeof client.generateObject>[0]);
      const obj = res.object as { city?: unknown; celsius?: unknown };
      if (typeof obj?.city !== 'string' || typeof obj?.celsius !== 'number') {
        return ko(this.id, this.label, `Objet non conforme: ${JSON.stringify(obj).slice(0, 120)}`);
      }
      return ok(this.id, this.label, `{city:"${obj.city}", celsius:${obj.celsius}}`);
    } catch (e) {
      return verdict(this.id, this.label, e);
    }
  },
};

/**
 * Prompt caching, measured rather than declared.
 *
 * Two identical calls with a long shared prefix. The second must report cached
 * input tokens. This is the probe that showed OpenRouter caching 49→98 % during
 * the audit while CAPABILITY_MATRIX declared `promptCaching: false` — the flag
 * means "we inject cache_control headers", not "no caching happens", and the
 * distinction matters for the cost model.
 */
export const promptCaching: Probe = {
  id: 'prompt-caching',
  label: 'Cache un préfixe répété (mesuré)',
  async run({ client, declared }) {
    // Long enough to clear provider minimums (Anthropic: 1024 tokens).
    const prefix = 'Contexte de référence. '.repeat(400);
    try {
      const first = await client.generateText({
        prompt: `${prefix}\n\nRéponds: A`,
        maxOutputTokens: 8,
      });
      const second = await client.generateText({
        prompt: `${prefix}\n\nRéponds: A`,
        maxOutputTokens: 8,
      });
      const u1 = usageOf(first);
      const u2 = usageOf(second);
      const cached = u2.cachedInputTokens ?? 0;
      const ratio = u2.inputTokens ? cached / u2.inputTokens : 0;
      const evidence = { firstUsage: u1, secondUsage: u2, cachedRatio: Number(ratio.toFixed(3)) };
      if (cached > 0) {
        return ok(
          this.id,
          this.label,
          `${Math.round(ratio * 100)} % du prompt relu depuis le cache` +
            (declared.promptCaching ? '' : ' — alors que la matrice déclare promptCaching:false'),
          evidence,
        );
      }
      // A NEGATIVE here is weak evidence. Observed on GLM 5.2 via OpenRouter:
      // 95 % cached on one run, 0 % on the next with the identical prefix — an
      // aggregator re-routes between upstreams, and each upstream has its own
      // cache state. So "no cache this run" must never be reported as "this
      // model does not cache".
      return declared.promptCaching
        ? ko(
            this.id,
            this.label,
            'La matrice déclare promptCaching:true mais aucun token caché n’est remonté.',
            evidence,
          )
        : {
            id: this.id,
            label: this.label,
            status: 'unsupported',
            detail:
              'Aucun cache observé sur CE run. Un résultat négatif ne prouve pas l’absence de ' +
              'cache : sur un agrégateur le routage change d’un appel à l’autre.',
            evidence,
          };
    } catch (e) {
      return meh(this.id, this.label, errMessage(e).slice(0, 200));
    }
  },
};

/**
 * Reasoning tokens. The runner round-trips chain-of-thought for some models;
 * knowing whether a model bills them is a cost fact, not a quality one.
 */
export const reasoningTokens: Probe = {
  id: 'reasoning-tokens',
  label: 'Facture des tokens de raisonnement',
  async run({ client }) {
    try {
      const res = await client.generateText({
        prompt: 'Combien font 17 × 23 ? Réponds par le nombre seul.',
        maxOutputTokens: 512,
      });
      const u = usageOf(res);
      const r = u.reasoningTokens ?? 0;
      return r > 0
        ? ok(this.id, this.label, `${r} tokens de raisonnement facturés`, { usage: u })
        : {
            id: this.id,
            label: this.label,
            status: 'unsupported',
            detail: 'Aucun token de raisonnement remonté.',
            evidence: { usage: u },
          };
    } catch (e) {
      return meh(this.id, this.label, errMessage(e).slice(0, 200));
    }
  },
};

/**
 * Error taxonomy on context overflow.
 *
 * Retrying an over-long prompt is pure waste — it will fail identically every
 * time. A harness that classifies this as retryable burns the retry budget and
 * the user's money for nothing, so what matters is that the error is
 * DISTINGUISHABLE, not that it is avoided.
 */
export const contextOverflowError: Probe = {
  id: 'context-overflow-error',
  label: 'Signale un dépassement de contexte de façon distinguable',
  async run({ client }) {
    // Far beyond any current context window, cheap to build.
    const huge = 'mot '.repeat(3_000_000);
    try {
      await client.generateText({ prompt: huge, maxOutputTokens: 8 });
      return ko(
        this.id,
        this.label,
        'Aucune erreur sur un prompt volontairement démesuré — le dépassement passe inaperçu.',
      );
    } catch (e) {
      const msg = errMessage(e);
      // An account problem masks the real answer — never call it an opaque
      // context error.
      if (isEnvironmentFailure(msg)) return verdict(this.id, this.label, e);
      const recognisable = /context|token|length|too (long|large)|maximum|exceed|trop long/i.test(
        msg,
      );
      return recognisable
        ? ok(this.id, this.label, `Erreur explicite: "${msg.slice(0, 100)}"`)
        : ko(
            this.id,
            this.label,
            `Erreur opaque, indistinguable d’une panne transitoire: "${msg.slice(0, 100)}"`,
          );
    }
  },
};

/**
 * Is the configured model id a floating alias?
 *
 * A floating id (`-latest`, undated) means the model under the name can change
 * without notice — the same class of defect as SUPPLY-001, one layer up.
 * Purely lexical, no call, no cost.
 */
export const modelIdPinning: Probe = {
  id: 'model-id-pinning',
  label: 'Identifiant de modèle épinglé',
  async run({ client }) {
    const id = client.config.model;
    const floating = /(-|:)latest$|^[^:]*$/.test(id) && !/\d{4}-?\d{2}-?\d{2}|\d+\.\d+/.test(id);
    return floating
      ? ko(
          this.id,
          this.label,
          `"${id}" ne porte ni date ni version — le modèle derrière ce nom peut changer sans préavis.`,
        )
      : ok(this.id, this.label, `"${id}" porte une version ou une date.`);
  },
};

/** Every probe, in the order a report should read them. */
export const ALL_PROBES: readonly Probe[] = [
  basicCompletion,
  usageAccounting,
  modelIdPinning,
  toolCallSingle,
  toolCallRoundTrip,
  streaming,
  structuredOutput,
  promptCaching,
  reasoningTokens,
  contextOverflowError,
] as const;
