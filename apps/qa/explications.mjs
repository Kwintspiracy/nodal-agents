// apps/qa/explications.mjs — ce que chaque page du portail MONTRE, à quoi elle
// sert, d'où viennent ses chiffres, et quand il faut agir.
//
// Écrit le 12/09/2026 parce que Quentin l'a dit sans détour : « je n'ai pas la
// moindre idée de ce que ça veut dire et de ce que ça montre ». Un tableau de
// bord qu'on ne sait pas lire ne vaut rien, quelle que soit la justesse de ses
// chiffres. Chaque page porte donc, en tête, deux phrases qui disent pourquoi
// elle existe, et un bouton « Understand this page » qui ouvre le texte complet.
//
// Les textes sont en ANGLAIS depuis le 14/09/2026 : le dépôt est public et le
// portail est publié, donc tout ce qu'il REND se lit en anglais. Ils parlent
// PRODUIT d'abord : ce qu'un utilisateur de Nodal peut ou ne peut pas faire, et
// ce que ça coûte de ne pas regarder. Le jargon (couverture, baseline,
// instabilité) est expliqué à l'endroit où il apparaît, jamais supposé.
//
// Une entrée par page (`id` = l'ancre de la page). `enBref` va sous le titre ;
// `parties` fait la modale. `blocs` porte les phrases posées au-dessus des
// tableaux et des cadres à l'intérieur de la page, clé par clé.

export const EXPLICATIONS = {
  chantiers: {
    titre: 'Work in flight',
    enBref:
      'The work board: what is waiting, what is underway, what is waiting for a review, what is done. Nothing is filed by hand, every card is a GitHub issue or pull request, and its column is deduced from facts.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>Answering "where do we stand?" at a glance, without opening GitHub or reading a report. It is the landing page because it is the question we ask most often.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>Six columns, left to right in the order work flows:</p>
<ul>
<li><b>To do</b>: what is waiting on a move or a call from you (an issue labelled <code>decision</code>).</li>
<li><b>In progress</b>: an open issue nobody has carried into a pull request yet.</li>
<li><b>In review</b>: an open pull request, or an issue that an open pull request closes ("Closes #n" in its body). The work is written, it is waiting to be read.</li>
<li><b>To test</b>: an issue labelled <code>test</code>: something to try out, or a doubt to settle.</li>
<li><b>Done</b>: closed issue, merged pull request. Capped at the most recent ones.</li>
<li><b>Abandoned</b>: a pull request closed without being merged.</li>
</ul>
<p>The left bar follows the same order as the eye: Work in flight, Capabilities, Gaps, Journeys, Test memory. Those five pages are the ones you steer with, and they read in that order.</p>
<p>Under the "How it runs" heading sit the four plumbing pages: the test overview, the bench, the triggers and the history. You open them when you doubt a number, not every day.</p>
<p>On a pull request card, the CI pill says whether its checks are green, red or still running. "CI green" does not mean "reviewed": a pull request is merged after a review AND green checks.</p>
<p>A "no verified facts" pill marks an open card that an agent opened without a <code>Verified</code> section stating the commands it ran and what they answered. Nothing in such a card was checked against npm, git or a test run, and that is precisely how a version published a week earlier became a task on this board.</p>
<p>Above the columns, the release block says what npm serves, what the repository carries, and how many commits sit on main since the last tag. If an open card asks to publish a version npm already has, it is named right there.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>From GitHub, through <code>gh issue list</code> and <code>gh pr list</code>, at collection time. Only the repository's own labels count: <code>decision</code>, <code>test</code>, <code>security</code>, <code>debt</code>, <code>cost</code>, <code>product</code>.</p>
<p>The board is read again every time an issue or a pull request moves, and once an hour as a safety net, so it is never older than the last deployment. The rest of the portal comes from the nightly measurement, which is far too heavy to run that often. The two dates sit at the bottom of the left bar: "measured" for what was run, "board as of" for what was read on GitHub.</p>
<p>If GitHub does not answer, the board says "missing" rather than showing an empty or stale list, an absence is never painted as a zero. A board already collected stays in place and keeps its own date, it is never passed off as fresh.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p><b>To do</b> is your column: every card there is waiting on something from you. <b>In review</b> belongs to the reviewer (Codex) and then to the merge. <b>In progress</b> growing with no pull request facing it is work that is not moving. <b>To test</b> going stale means doubts we have stopped settling.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Neither the priority between two cards in the same column, nor the time spent. An "In progress" card does not say whether anyone is actually working on it, only that it is neither settled, nor carried by a pull request, nor closed.</p>`,
      },
    ],
    blocs: {
      release:
        'What npm serves right now, against what this repository carries. Both numbers are read from npm and from git at collection time, never typed in, so a card asking to publish a version that is already published gets named here instead of being believed for four days.',
    },
  },

  capacites: {
    titre: 'What the product can do',
    enBref:
      'The only page that talks about the PRODUCT rather than the code: one row per thing a user believes they can do (create an agent, connect Notion, approve an action…), and what proves it, at two levels, the screen and the engine. It hands down no verdict: it says which proofs exist and what the last measurement said about them.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>"<code>apps/web</code> is 78% covered" answers no question anyone actually asks. "Can a user connect Notion this morning, and what shows it?", that one does. This page ties every product capability to the tests that prove it.</p>
<p>It handed down a single word until 12/09, "proven", "broken", and that word lied by omission. "Give tools" showed as <i>proven</i> because three BROWSER journeys passed; the tests that prove the promise (an agent can only call the tools it was given) were labelled nowhere. And <i>broken</i> did not say whether it was the product or the browser that had given up.</p>
<p>This is what a product manager calls a <i>traceability matrix</i>: the link between what we promise and what we verify. Most teams do not have one, and find out a promise is broken when a user complains.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>Two columns per capability, and they do not prove the same thing:</p>
<ul>
<li><b>Screen</b>: a journey in a real browser, or a component test. It proves the buttons exist, that they chain together, and that the page shows what it should. It does NOT prove anything happens behind: a screen can be green in front of an unplugged engine.</li>
<li><b>Engine</b>: a test of the runner, the tools, the orchestration or the database. It proves the promised thing IS DONE: that a tool off the list is refused, that memory is read back, that approval really blocks. It does NOT prove a user can get there: a perfect engine behind an unfindable button serves nobody.</li>
</ul>
<p>Hence the rule: <b>a capability is only truly verified if both exist and pass</b>. A single green level is half an answer, and the page says so in plain words instead of rounding it up.</p>
<p>In each column, a result and nothing else: <b>passed</b>, <b>failed</b>, <b>flaky</b> (green or red depending on the day), <b>skipped</b> (someone turned it off, it can be turned back on), <b>never run</b> (the test exists, no run has reached it), <b>not tested</b> (nobody wrote that level). Under the result, the tests that carry it; past three, the rest unfolds.</p>
<p><b>Red only ever appears on a proof that FAILED.</b> An absence is grey, and it is said out loud: painting it red would send someone hunting a fault where nobody wrote a test.</p>
<p>Under the capability name, one sentence sums the row up, "screen passed · engine not tested". That is two facts, never a verdict.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>The capability registry is the file <code>apps/qa/capacites.mjs</code>: 24 rows, each with the question the user asks. It is DERIVED from the real journeys and screens, never imagined.</p>
<p>A test says what it proves, and at which level, by writing <code>@cap:&lt;slug&gt;/ecran</code> or <code>@cap:&lt;slug&gt;/moteur</code> in its title. Placed on a <code>describe</code>, the label holds for every case inside it. The portal reads the TITLES of the versioned tests (never a comment, never a string), then crosses them with the results of the last measurement to say whether the proof ran, and how.</p>
<p>A label written without a level (the old form, <code>@cap:&lt;slug&gt;</code>) is still read, but it counts for neither column: filing it under "screen" by default would paint an engine green that nobody tested. It is shown separately, under the row, and the gate flags it, this is temporary.</p>
<p>When a capability has no engine test, the registry carries in one sentence what such a test <i>should</i> check. That is the plan of work, written where it gets read.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>A <b>failed proof</b> comes before everything else, and the level says what to look for: a fallen SCREEN means the journey no longer chains, often a selector, sometimes the browser environment; a fallen ENGINE means the promised thing is no longer done, and there a user is really hurt.</p>
<p>A capability <b>with no engine proof</b> is the hole the old word hid: we check the façade every day without ever checking what is behind it. That is not a fault, it is a test to write. A capability <b>with no proof at all</b> is a promise to prove, or to drop from the registry if it no longer exists.</p>
<p>The gate <code>pnpm capacites:check</code> runs on every pull request and refuses two things: a label that names no capability (a typo, a renamed slug), and a required capability no test claims any more. It FLAGS without blocking a label with no level. It judges no result, that is the nightly measurement's job.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>That a passing test really proves the capability. <b>A green test verifies what that test verifies, not the whole promise.</b> A screen journey can carry the label and click a single button; an engine test can check a function and miss the path the product calls it through. Two green levels shrink the lie, they do not remove it: the quality of a proof stays a matter of review, not of portal.</p>
<p>It does not say the two levels are worth the same either. They answer two different questions, and neither replaces the other.</p>
<p>The "see the run" link leads to the GitHub Actions run that saw this red. There you find the full log of the journey, and the <code>parcours-en-echec</code> artifact: Playwright's traces and screenshots, that is, what the user would have seen the moment it broke. Playwright takes a screenshot ONLY ON FAILURE, and a trace only when it retries a fallen test: on a green test there is nothing to look at. You do not find the cause there either, the link shows the symptom, it does not explain it, and the artifact is kept fourteen days, after which the link leads to the run without its pieces.</p>`,
      },
    ],
    blocs: {
      compteurs:
        'Each card states a FACT, not a verdict. "Failed proofs" is the only one that talks about a fault; the other three count proofs nobody ever wrote, a plan of work, not an alarm.',
      registre:
        'One row per capability, grouped by product domain. Two columns: what the SCREEN said, what the ENGINE said. Under each result, the tests that carry it.',
    },
  },

  vue: {
    titre: 'Tests, overview',
    enBref:
      'How many tests the repository carries, how much of the code they actually exercise, and how many user journeys the CI really plays. This is the "code health" page, useful to an engineer, less telling for the product (for that, see Capabilities).',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>Knowing whether the safety net exists, and where it has holes. A repository can hold thousands of tests and still leave 40% of its code with no test going through it. This page measures that instead of assuming it.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p><b>Line coverage</b>: out of 100 lines of code, how many at least one test executed. 81% means 19 lines out of 100 are crossed by no test, if one of them breaks, nothing will say so before a user does. It is NOT "81% of the code is correct": a line run by a test can still be wrong if the test does not check the right result.</p>
<p>Under the gauge, one sentence says where that number is going: "up 2 points over 7 days", "down", or "stable". Seven days, because the question under that number is "did we just add code without tests", not "where were we this month". Two collections in the week are needed for a trend to exist; otherwise the sentence says so and invents nothing. The full history, over 30 days and as curves, is on the History page.</p>
<p><b>Branches</b>: at every "if" there are two paths; this percentage says how many of the two a test took. Always lower than lines, and more honest.</p>
<p><b>Test cases</b>: the number of <code>it(…)</code> in the repository. A vanity number on its own, it says nothing about what they check.</p>
<p><b>Journeys played by the CI</b>: the end-to-end scenarios (a real browser, a real page) that continuous integration actually runs. This is the number that got this portal built: 28 out of 30 were never played.</p>
<p>The per-package table is sorted by UNCOVERED lines: what sits on top is what costs the most to ignore. A hatched package does not have zero, it has nothing, it was never measured.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>The nightly measurement runs each package's tests with coverage instrumentation (<code>vitest --coverage</code>, V8 engine), package by package, never all together, each carries its own environment. Every package writes a summary; the collector adds them up. Coverage could NEVER run before 10/09/2026: it was declared and its tool was installed nowhere.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>When a package EVERYBODY goes through sits low: <code>nodal-agents</code> (the CLI, 50%) is the one that installs and starts the product, every user goes through that code. A package at 60% that only renders cards is less urgent.</p>
<p>Coverage that DROPS between two measurements (see History) says code was added without tests. That is not an alert, it is a trend to watch.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Whether the tests check anything useful. A test that calls a function and does not look at the result covers lines and proves nothing. That is why the repository's rule demands asserting on the real result, a review rule, not a portal one.</p>`,
      },
    ],
    blocs: {
      cartes:
        'Four numbers: the share of code a test goes through, the number of tests, the share of user scenarios the CI plays, and the number of bench sections. The first one only holds for the measured packages.',
      paquets:
        'A package = a folder of the repository with its own code (the runner, the web app, the tools…). Sorted by what costs the most to ignore: the lines nobody tests.',
    },
  },

  ecarts: {
    titre: 'Gaps',
    enBref:
      "What today's measurement holds against the repository, sorted by severity. This list is COMPUTED from the other pages, never written by hand: it changes when the repository changes. It is the page to read when you only have a minute.",
    parties: [
      {
        titre: "What it's for",
        texte: `<p>A portal that shows twenty tables does not say where to start. This page does: it takes everything the other pages measure, keeps what is abnormal, and sorts it by what ignoring it costs.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>Three severities:</p>
<ul>
<li><b>High</b>: something is broken or has turned red: a required capability down, a test that turned red in the last two days, a bench section that regressed or could not run, journeys the CI never plays. This is what wakes someone up: the nightly measurement opens ONE issue ("Portal: what is red") with exactly these lines, keeps it up to date, and closes it when there is nothing left.</li>
<li><b>Medium</b>: a sleeping proof, a flaky test. Nothing is broken, but we do not know.</li>
<li><b>Low</b>: a plan of work: capabilities never proven, a history that is too short. It only moves slowly.</li>
</ul>
<p>Every gap names what it concerns (the tests, the capabilities, the packages): that is the way through to the detail page.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>From the <code>ecartsDe</code> function in <code>apps/qa/lib.mjs</code>, which re-reads the collection: the capability registry, the test memory, the bench report, the journeys and the packages. It is tested, every rule has a test that says which real case motivated it.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>A <b>high</b> severity is dealt with the same day, or explicitly requalified (an issue that says why we are waiting). The rest is handled in the order shown. A list that has not moved in a week says we have stopped reading it.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Why something is broken. The gap names the test; the reason is in its run report, on GitHub Actions, or by replaying it locally.</p>`,
      },
    ],
    blocs: {},
  },

  parcours: {
    titre: 'Journeys',
    enBref:
      'The end-to-end scenarios: a real browser doing what a user would do, open the page, create an agent, connect a service. It is the net closest to real usage, and the most fragile.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>A unit test checks a function; a journey checks that EVERYTHING holds together, the way a user would see it. A regression that breaks a screen shows up in no unit test, it shows up here, or at the user's.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>Journeys are grouped by <b>cadence</b>: how often the CI plays them.</p>
<ul>
<li><b>Every pull request</b>: played before every merge: it BLOCKS a regression. Two journeys only (the smoke test).</li>
<li><b>Every night</b>: played by the nightly measurement: it OBSERVES a regression after the fact, without blocking it.</li>
<li><b>By hand</b>: versioned, played by no CI. It only exists on paper.</li>
</ul>
<p>Under the file name, the <b>description</b>: the first sentence of its header, the one its author wrote to say what the journey does. When the file carries none, the row says "no description" rather than nothing, that is something to fix in the file, not in the portal.</p>
<p>Every row carries its last result, case by case: <b>green</b>, <b>red</b>, <b>skipped</b> (the test turned itself off, often because an external service is missing), <b>flaky</b> (passed on the second attempt, that is not a green). A "red" journey is not necessarily a product fault: on a fresh runner, with neither Google nor Notion configured, a journey that expects them fails for an environment reason.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>From the <code>apps/web/tests/e2e/*.spec.ts</code> files (Playwright). The description is read from the file itself: the first comment block, imports aside, up to its first blank line, decorative banners (<code>── Constants ───</code>) are skipped, and failing a header it is the title of the first <code>describe</code>. The cadence is READ from the CI workflow files, not declared: if nobody runs a journey, the portal says so. The last result comes from Playwright's JSON report, produced by the nightly measurement, which plays 29 journeys out of 30 (<code>agent-flows</code> is excluded: it expects an LM Studio on Quentin's machine).</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>A journey red for a short while (see "Red since" in Test memory) is a regression to understand fast. A journey red forever on the runner and green locally is an environment gap to settle: either the test must turn itself off cleanly when the service is missing, or the runner must have the service.</p>
<p>The underlying question, still open: which of these journeys should move from "every night" to "every pull request", to BLOCK a regression instead of observing it? Every promotion costs CI minutes per pull request.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>The cause of a red. For that: the run's Playwright report (traces, screenshots), or replay the journey locally with <code>pnpm --filter @nodal-agents/web exec playwright test &lt;file&gt;</code> on a running stack.</p>
<p>The "see the run" link leads to the GitHub Actions run that saw this red. There you find the full log of the journey, and the <code>parcours-en-echec</code> artifact: Playwright's traces and screenshots, that is, what the user would have seen the moment it broke. Playwright takes a screenshot ONLY ON FAILURE, and a trace only when it retries a fallen test: on a green test there is nothing to look at. You do not find the cause there either, the link shows the symptom, it does not explain it, and the artifact is kept fourteen days, after which the link leads to the run without its pieces.</p>`,
      },
    ],
    blocs: {
      cadence:
        'Three groups by cadence: played on every pull request (blocks), every night (observes), by hand (never). The last result is case by case, a journey can be partly green, partly skipped.',
    },
  },

  banc: {
    titre: 'Bench',
    enBref:
      'The bench does not ask "is it broken?" but "what CHANGED, and by how much": the size of the prompt, the number of architecture rules, the cost of a turn… Every measurement has an accepted reference value; drifting from it is a regression.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>Some things are neither true nor false, they have a VALUE: the token count of a prompt, the number of files breaking a rule, the duration of a startup. A test cannot guard those, it would have to pick a threshold. The bench keeps the last ACCEPTED value and flags any drift: it is a drift detector.</p>
<p>Example: the system prompt of a chat turn weighed 9,000 tokens. Without a bench, it could have climbed to 12,000 without a single test turning red.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>A <b>section</b> = one measured subject (architecture, catalogue, security gates, trust boundary…). Each section lists its <b>metrics</b> with the reference value (the <i>baseline</i>), the commit where it was accepted, and the desirable direction (lower is better, or higher is better).</p>
<p>The banner at the top gives the verdict of the last run: no regression, or the list of sections that <b>regressed</b> (a value moved the wrong way), or that <b>could not run</b> (a fault, not a slowdown, the two are not handled the same way).</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p><code>pnpm bench</code> (the <code>packages/bench</code> package) measures each section and compares against the <code>bench/baselines/*.json</code> files. The CI runs it on every pull request as a blocking gate; the nightly measurement runs it too and files its report for this page.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>A <b>regression</b> demands a decision: either it is a fault (we fix it), or it is a change we own (we accept the new value with <code>pnpm bench --update</code>, and the commit explains why). Never one without the other. A section <b>that is down</b> gets repaired before anything else: it guards nothing any more.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Whether a value is GOOD. The bench only knows "same" and "different". That 4,770 tokens is a fair price for a chat turn is a judgement, the bench only keeps us from climbing back to 9,000 without saying so.</p>`,
      },
    ],
    blocs: {
      sections:
        'One card per measured section. The baseline is the last accepted value, with the commit that accepted it: that is what the next run will be compared against.',
    },
  },

  ci: {
    titre: 'What triggers what',
    enBref:
      'The answer to "what runs the tests, and when". Read from the GitHub Actions workflow files, not from an intention: if a journey is named nowhere, nobody plays it.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>Tests that exist but that nothing runs protect nothing. This page says, workflow by workflow, what fires (on every pull request, on every push to main, every night, or by hand), what it runs, and whether the bench is part of it.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>A <b>workflow</b> = a file in <code>.github/workflows/</code>, a list of steps GitHub runs on a fresh machine. Nodal has three:</p>
<ul>
<li><b>CI</b>: on every pull request and every push to main: unit tests, architecture, bench, two smoke journeys, the published package installed from scratch. This is the gate: red = no merge.</li>
<li><b>Quality, full measurement</b>: every night at 03:17 UTC (and by hand): coverage of the 34 packages, bench, the 29 journeys, then it writes its data to main and opens or closes the alert issue. This is what feeds this portal.</li>
<li><b>Deploy Docs</b>: the public documentation, and this portal with it under <code>/qa/</code>. It also fires after every measurement, so a night of work reaches the page it feeds.</li>
</ul>
<p>The <b>triggers</b> are the events that start the workflow; the <b>jobs</b> are its parallel parts; "Journeys played" the scenarios it runs by name.</p>
<p><b>The price of a pull request</b>, at the top of the page, is how long you wait for its checks. Four numbers:</p>
<ul>
<li><b>Median</b>: the middle duration. Not the mean: one run that waited an hour in the queue pulls a mean up and makes it look normal. The median says what happens one time out of two, and does not move for an accident.</li>
<li><b>Last</b> and <b>worst</b>: yesterday's case, and the extreme case you can still hit.</li>
<li><b>Trend</b>: the first half of the runs compared to the second. Past a 15% gap it says "up" or "down"; below that, "stable".</li>
</ul>
<p>The duration counted is <b>wall to wall</b>: from the run being created to its end, queue included. That is what you actually wait for, and not the sum of the jobs' compute time, which describes what the CI consumes and not what it puts you through.</p>
<p>Only <b>green</b> runs count. A red one stops at the first check that falls, often in three minutes: counting them would lower the number every time the CI is in a bad way, which is exactly when you come to look at it.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>From the text of the workflow files, read by the collector. An early version looked for an invisible character and showed "by hand" for everything, hence the tests that guard this reading today.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>When a workflow announces a cadence GitHub does not keep: the nightly measurement did not run by itself the first two nights (issue #69). When a journey you believe protects you is "by hand". When the bench is run by no workflow.</p>
<p><b>Past a 25-minute median</b>, the page opens a high-severity gap, and here is why that threshold and not another: under a quarter of an hour, you wait for your merge without thinking about it; past twenty minutes or so, you go do something else and come back. From there on, what gets shortened is never the machine, it is the content of the CI. Someone drops a suite, marks a test <code>skip</code>, takes the journeys out of the gate. The price of a pull request is therefore the leading indicator of the next guard we are about to lose, and that is the moment to split the CI or parallelise it, while there is still a choice.</p>
<p><b>A rise of more than 25%</b> over the window opens a medium gap. A drift is repaired while it is small; once settled, it becomes the normal nobody argues with any more.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Whether the workflows ACTUALLY ran, nor their result: that is GitHub's Actions tab, and this portal's History for the nightly measurement.</p>
<p>The price, for its part, does not say WHERE the time goes. It measures the wait, never its cause: a saturated GitHub queue and a test suite that doubled give the same number. To know which of the two, you have to open a run and look at its job durations.</p>`,
      },
    ],
    blocs: {
      prix: "How long you wait for a pull request's checks, over the CI's last thirty green runs. It is this number that decides the fate of the tests: when the wait becomes unbearable, it is the suite that gets shortened.",
    },
  },

  memoire: {
    titre: 'Test memory',
    enBref:
      'One record per test, kept from one measurement to the next: how many times it ran, how many times it fell, how long it has been red. It is the only page that sees TIME, and therefore flakiness, invisible in an isolated run.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>A test that falls one time in three is more harmful than a broken test: it passes for green every time it passes, and casts doubt on every red. No single run can see it. You have to remember the previous runs, that is this page.</p>
<p>It can also date a problem: a test that turned red yesterday is a regression (something moved, and we know when); a test red for three months is a debt we have learned not to see. The two are not handled the same way.</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>Four counters: <b>flaky</b> (green AND red within their recent window), <b>broken</b> (red at their last runs), <b>tracked</b> (every one we have seen at least once), and <b>repaired in (median)</b>.</p>
<p><b>Repaired in (median) N days</b> answers "when a test breaks, how long does it stay broken". A repository with twenty reds repaired in a day and one with twenty reds repaired in forty are not in the same state at all, and the number of reds does not tell them apart. Only repairs seen end to end count: the test was green, we saw it fall, we saw it come back. A test already red before the first measurement has no starting point, therefore no duration.</p>
<p>The <b>median</b> and not the mean: it is the value that cuts the repairs into two halves. A single repair forgotten for six months pulls a mean up and makes it look normal; the median does not move for an accident. As long as no repair has been observed, the box shows "·": no absence is painted as a zero.</p>
<p>In the tables, the <b>ribbon</b> reads left to right, oldest to newest: one letter per run, green, red, skipped, flaky. <b>Rate</b> = failures over runs. <b>Red since</b> = the date we SAW it flip from green to red, never the date we started looking, otherwise the first collection would have presented twenty-two old reds as regressions of the day.</p>
<p>The first table, "The most harmful", is sorted by failure rate.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>From the file <code>apps/qa/data/tests.ndjson</code>: one line per test, written to main by the nightly measurement. Every measurement merges its results into it: a test seen again advances its counters, a test absent from the measurement does not move (it did not run, counting a run, or worse a failure, would make every rate lie). A "flaky" test here is not the same word as a "flaky" journey on the Journeys page: over there it is "passed on the second attempt within the same run", here it is "green one day, red the next".</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>A <b>fresh red</b> (within the last two days) gets understood the same day: it is a dated regression. A <b>flaky</b> test gets repaired or removed, never ignored, it poisons trust in the others.</p>
<p>Past <b>14 days</b>, the "Age" column turns red and the Gaps page names these tests. The threshold is not a science: two weeks is the moment when nobody remembers what broke any more, and when a red stops being a regression and becomes a decision we did not take. Those rows wake nobody up (they no longer move) but they are named, otherwise they end up invisible from sheer presence. Two ways out only: repair, or delete the test along with the capability it proved.</p>
<p>This page is worth nothing in the first days: it needs several runs before it can say anything at all. It started on 10/09/2026.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Why a test is flaky. The usual causes: a timeout too short, an execution order that matters, an external service that answers sometimes. The portal names the test; the cause is found by replaying it.</p>
<p>The "see the run" link leads to the GitHub Actions run that saw this red. There you find the full log of the journey, and the <code>parcours-en-echec</code> artifact: Playwright's traces and screenshots, that is, what the user would have seen the moment it broke. Playwright takes a screenshot ONLY ON FAILURE, and a trace only when it retries a fallen test: on a green test there is nothing to look at. You do not find the cause there either, the link shows the symptom, it does not explain it, and the artifact is kept fourteen days, after which the link leads to the run without its pieces.</p>`,
      },
    ],
    blocs: {
      nuisibles:
        'The tests that fall most often relative to their runs. A 30% rate over ten runs is worse than a test that is always red: you never know whether to believe it.',
      casses:
        'Red at their last runs. "Red since" only dates the flips we saw: a test red since before the first measurement has no date, and that is honest. "Age" counts the days as of the collection, not as of when you open the page; past 14 days it turns red.',
    },
  },

  historique: {
    titre: 'History',
    enBref:
      'One line per collection: when, triggered by what, on which commit, with which headline numbers. This is what will make TRENDS readable, coverage sliding, a test count going flat, and the real regularity of the measurement.',
    parties: [
      {
        titre: "What it's for",
        texte: `<p>One snapshot does not say whether things are getting better or worse. Two do. This page keeps every collection so that the other pages can one day say "coverage lost two points this week" instead of "coverage is at 81%".</p>`,
      },
      {
        titre: 'How to read it',
        texte: `<p>One line per collection, most recent on top. <b>Trigger</b> says where it came from: <code>schedule</code> (at night, on its own), <code>workflow_dispatch</code> (started by hand on GitHub), <code>local</code> (started on a workstation, those lines should not be pushed to main). <b>Commit</b> is what was measured. The numbers are the Overview's, frozen at that moment.</p>
<p>Two collections a day or two a week reads right here: this is the real regularity, not the cron's.</p>
<p>The <b>three curves</b> at the top plot the same numbers over 30 days: line coverage, proven capabilities (out of 24), broken tests. The number next to the title is the <b>delta</b>: the difference between the first and the last collection of the window. "+2.1%" means coverage gained 2.1 points over the period, not that it is worth 2.1%.</p>
<p>The vertical axis is scaled to the data, not anchored at zero: a two-point coverage move is what you came to look at, and starting from zero would make it invisible. With a single collection in the window, the point is drawn and the curve says "no trend yet", two snapshots make a trend, one does not.</p>`,
      },
      {
        titre: 'Where it comes from',
        texte: `<p>From the file <code>apps/qa/data/history.ndjson</code>, one line appended at the end of every collection by <code>collect.mjs</code>.</p>
<p>The curves leave two things out. The <code>local</code> collections first: started from a workstation, on a tree that is not main and often on part of the tests only. Mixed in with the nightly measurements, they create drops that match no change in the repository. Missing values next: coverage that could not be measured is not coverage of zero, and plotting it as such would invent a fall. The table, for its part, shows everything, <code>local</code> included.</p>`,
      },
      {
        titre: 'When to act',
        texte: `<p>When the <code>schedule</code> lines are missing: the nightly measurement is not running. When a number slides several collections in a row the wrong way: coverage going down is code added without tests; proven capabilities going down is a product promise no longer held by any played test. A single flip means nothing, a slope over three collections does.</p>`,
      },
      {
        titre: 'What it does not tell you',
        texte: `<p>Anything finer than a collection. The test-by-test detail is in Test memory.</p>`,
      },
    ],
    blocs: {
      courbes:
        'The same numbers as the Overview, but over 30 days. The figure next to the title is the gap between the first and the last collection of the window. Collections started from a workstation are left out: they do not measure main.',
    },
  },
};

/** Les identifiants de page que ce module connaît — pour que le rendu et le test s'accordent. */
export const PAGES_EXPLIQUEES = Object.keys(EXPLICATIONS);
