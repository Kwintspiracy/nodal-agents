-- 0170 — what became of a tool call, and what it acted on (#1184, #1206).
--
-- Until now a tool call had no outcome of its own. The seam that runs tools
-- decided "success" or "error" by whether the tool's function threw, wrote
-- that verdict INSIDE `tool_output` (an envelope `{"outcome":"error",...}` for
-- a failure, the bare output for a success), and every reader guessed it again
-- from that text: the runner in one way, the web in three, the bench in
-- another. A tool that RETURNED its failure (`{ok:false}`, `isError: true`, a
-- command that timed out) was recorded as a success by all of them.
--
-- From now on the seam writes the outcome ONCE, in `outcome`, from what the
-- tool declares, in the closed set of `@nodal-agents/shared`
-- (`TOOL_CALL_OUTCOMES`), and what the call acted on in `target`. Readers read
-- the column, through `readCallOutcome`, and nothing else.
--
-- EXISTING ROWS. This migration types, once, only what was written
-- EXPLICITLY at the time, and leaves every other row NULL — "not recorded",
-- which its readers say as such. It never turns a returned output into
-- `done`: that is exactly the reading that was wrong.
--   - the seam's failure envelope: `{"outcome":"error",...}` is `failed`,
--     `unknown` when it carried `mayHaveDelivered` (a send transmitted and
--     never answered), `refused` when its text is the gate's `blocked:` or
--     the refusal of an already rejected call;
--   - the seam's held call, `{"outcome":"awaiting_approval",...}`;
--   - the seam's delegation request, `{"outcome":"delegation_requested",...}`:
--     the request was made (the child's own fate is on the child's row);
--   - an intent mark that never got its output (#443): it MAY have taken
--     effect, which is what `unknown` means;
--   - the two refusal envelopes the screens already read as "changed nothing":
--     a CLI's `<tool_use_error>` and a builtin's `{"ok":false`.
-- `target` stays NULL on every existing row: what an old call acted on was
-- never recorded, and is not reconstructed.

ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS target text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tool_calls_outcome_check'
  ) THEN
    ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('done','failed','unknown','refused','awaiting_approval'));
  END IF;
END $$;

UPDATE tool_calls
SET outcome = CASE
    WHEN tool_output LIKE '{"outcome":"error"%' AND tool_output LIKE '%"mayHaveDelivered":true%'
      THEN 'unknown'
    WHEN tool_output LIKE '{"outcome":"error","error":"blocked:%'
      OR tool_output LIKE '{"outcome":"error","error":"approval_already_rejected%'
      THEN 'refused'
    WHEN tool_output LIKE '{"outcome":"error"%' THEN 'failed'
    WHEN tool_output LIKE '{"outcome":"awaiting_approval"%' THEN 'awaiting_approval'
    WHEN tool_output LIKE '{"outcome":"delegation_requested"%' THEN 'done'
    WHEN tool_output IS NULL AND execution_started IS TRUE THEN 'unknown'
    WHEN left(tool_output, 400) LIKE '%<tool_use_error>%' THEN 'failed'
    WHEN tool_output ~ '^\s*\{"ok"\s*:\s*false\M' THEN 'failed'
  END
WHERE outcome IS NULL
  AND (
    tool_output LIKE '{"outcome":%'
    OR (tool_output IS NULL AND execution_started IS TRUE)
    OR left(tool_output, 400) LIKE '%<tool_use_error>%'
    OR tool_output ~ '^\s*\{"ok"\s*:\s*false\M'
  );
