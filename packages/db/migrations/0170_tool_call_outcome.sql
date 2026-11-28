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
-- EXISTING ROWS are typed ONCE, here, by the rule the seam applies from now
-- on, and by nothing else: what the seam wrote explicitly is that, what a tool
-- returned is `done` unless the tool declares otherwise, and each declaration
-- 0170 introduces is written below for the shape it reads. This is said here,
-- in the migration, rather than left to the readers to guess again:
--   - the seam's failure envelope: `{"outcome":"error",...}` is `failed`,
--     `unknown` when it carried `mayHaveDelivered` (a send transmitted and
--     never answered), `refused` when its text is the gate's `blocked:` or
--     the refusal of an already rejected call;
--   - the seam's held call, `{"outcome":"awaiting_approval",...}`;
--   - the seam's delegation request, `{"outcome":"delegation_requested",...}`:
--     the request was made (the child's own fate is on the child's row);
--   - an intent mark that never got its output (#443): it MAY have taken
--     effect, which is what `unknown` means;
--   - the refusal envelopes: a CLI's `<tool_use_error>`, a builtin's
--     `{"ok":false` (the file, office, skill and meta tools' declaration);
--   - the other declarations: a command with no exit status (`run_command`,
--     `run_skill_script`: killed at its timeout, stopped, never started), a
--     coding run in error (`code_task`), a refused proof declaration
--     (`declare_verification`), a provider still running (`poyo_generate_image`,
--     `apify_run_actor`) or a run that ended badly (`apify_run_actor`);
--   - any other row with an output: the call returned, `done`;
--   - a row with no output that never started: nothing to say, NULL.
-- `target` stays NULL on every existing row: what an old call acted on was
-- never recorded, and is not reconstructed (the verdict per target resolves
-- nothing on a NULL target; old jobs are finished anyway).

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
    WHEN tool_output IS NULL THEN NULL
    WHEN left(tool_output, 400) LIKE '%<tool_use_error>%' THEN 'failed'
    WHEN tool_output ~ '^\s*\{"ok"\s*:\s*false\M' THEN 'failed'
    WHEN tool_name IN ('run_command', 'run_skill_script') AND tool_output LIKE '%"exitCode":null%'
      THEN 'failed'
    WHEN tool_name = 'code_task' AND tool_output LIKE '%"isError":true%' THEN 'failed'
    WHEN tool_name = 'declare_verification' AND tool_output LIKE '{"declared":false%' THEN 'failed'
    WHEN tool_name = 'poyo_generate_image' AND tool_output LIKE '%"status":"running"%' THEN 'unknown'
    WHEN tool_name = 'apify_run_actor' AND tool_output LIKE '%"status":"SUCCEEDED"%' THEN 'done'
    WHEN tool_name = 'apify_run_actor'
      AND (tool_output LIKE '%"status":"FAILED"%' OR tool_output LIKE '%"status":"ABORTED"%'
        OR tool_output LIKE '%"status":"TIMED-OUT"%')
      THEN 'failed'
    WHEN tool_name = 'apify_run_actor' THEN 'unknown'
    ELSE 'done'
  END
WHERE outcome IS NULL;
