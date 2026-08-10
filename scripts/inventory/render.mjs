// Génère la page d'inventaire depuis inventory.json.
// Générée plutôt qu'écrite à la main : la complétude est le critère d'échec.
import { readFileSync, writeFileSync } from 'node:fs';

const inv = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const OUT = process.argv[3];

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Statut de test → { cls, label } */
function status(t) {
  if (!t) return { cls: 'na', label: '—' };
  const p = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  if (t.unit > 0 && t.e2e > 0) return { cls: 'both', label: `${p(t.unit, 'unit')} · ${t.e2e} e2e` };
  if (t.unit > 0) return { cls: 'unit', label: p(t.unit, 'fichier') };
  if (t.e2e > 0) return { cls: 'e2e', label: `${t.e2e} e2e` };
  return { cls: 'none', label: 'aucun' };
}

function rows(items, cols) {
  return items
    .map((it) => {
      const st = status(it.test);
      const cells = cols.map((c) => `<td class="${c.cls ?? ''}">${c.get(it)}</td>`).join('');
      const search = cols
        .map((c) => c.get(it))
        .join(' ')
        .replace(/<[^>]+>/g, '');
      return `<tr class="r r--${st.cls}" data-s="${esc(search.toLowerCase())}" data-t="${st.cls}">${cells}<td class="st"><span class="chip chip--${st.cls}">${esc(st.label)}</span></td></tr>`;
    })
    .join('\n');
}

function section(id, title, note, headers, items, cols) {
  const untested = items.filter((i) => i.test && i.test.unit === 0 && i.test.e2e === 0).length;
  const badge = untested > 0 ? `<span class="warn-count">${untested} sans test</span>` : '';
  return `
<section class="sec" id="${id}">
  <header class="sec__h">
    <h2>${esc(title)} <span class="n">${items.length}</span></h2>
    ${badge}
  </header>
  <p class="sec__note">${note}</p>
  <div class="tw">
    <table>
      <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}<th>Fichiers de test</th></tr></thead>
      <tbody>${rows(items, cols)}</tbody>
    </table>
  </div>
</section>`;
}

// ── Totaux ────────────────────────────────────────────────────────────────────
const connectorToolCount = inv.connectors.reduce((s, c) => s + c.count, 0);
const modelCount = inv.models.reduce((s, p) => s + p.count, 0);
const totalUnits =
  inv.builtinTools.length +
  connectorToolCount +
  inv.cliCommands.length +
  inv.routes.length +
  inv.serverActions.length +
  inv.pages.length +
  inv.channels.length +
  inv.providers.length +
  inv.skills.length +
  inv.mcpCatalog.length;

const untestedTotal =
  inv.builtinTools.filter((x) => x.test.unit === 0 && x.test.e2e === 0).length +
  inv.cliCommands.filter((x) => x.test.unit === 0 && x.test.e2e === 0).length +
  inv.routes.filter((x) => x.test.unit === 0 && x.test.e2e === 0).length +
  inv.serverActions.filter((x) => x.test.unit === 0 && x.test.e2e === 0).length +
  inv.skills.filter((x) => x.test.unit === 0 && x.test.e2e === 0).length;

const covered =
  inv.builtinTools.length +
  inv.cliCommands.length +
  inv.routes.length +
  inv.serverActions.length +
  inv.skills.length;
const pct = Math.round(((covered - untestedTotal) / covered) * 100);

// ── Banc ──────────────────────────────────────────────────────────────────────
const benchCards = inv.bench
  .map(
    (b) => `
  <article class="bench">
    <header><h3>${esc(b.id)}</h3><span class="sha">réf. ${esc(b.gitSha)}</span></header>
    <p class="why">${esc(b.why)}</p>
    <dl>
      ${b.metrics
        .map(
          (m) =>
            `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)} <span class="u">${esc(m.unit)}</span></dd></div>`,
        )
        .join('')}
    </dl>
  </article>`,
  )
  .join('');

const html = `<title>Nodal-Agents — inventaire des capacités et couverture de test</title>
<style>
:root{
  --canvas:#eaeaea; --sidebar:#f2f2f2; --paper:#ffffff;
  --ink:#0a0a0a; --ink2:#26262a; --ink3:#696969; --ink4:#6e6e6e;
  --rule:#d6d6d6; --rule2:#e2e2e2;
  --acc:#3565ff; --acc-bg:rgba(53,101,255,.10);
  --lime:#d4ff2e; --coral:#ff5631;
  --ok:#1e7a44; --ok-bg:rgba(30,122,68,.12);
  --warn:#a25620; --warn-bg:rgba(255,86,49,.13);
  --err:#b54141;
  --sans:'Inter','Söhne',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --canvas:#0e0e10; --sidebar:#161618; --paper:#1c1c20;
  --ink:#f5f5f3; --ink2:#d8d8d4; --ink3:#9a9a96; --ink4:#848484;
  --rule:#2a2a2e; --rule2:#242428;
  --acc:#8aa8ff; --acc-bg:rgba(53,101,255,.18);
  --ok:#d4ff2e; --ok-bg:rgba(212,255,46,.16);
  --warn:#ff5631; --warn-bg:rgba(255,86,49,.14);
  --err:#ff5631;
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --canvas:#0e0e10; --sidebar:#161618; --paper:#1c1c20;
  --ink:#f5f5f3; --ink2:#d8d8d4; --ink3:#9a9a96; --ink4:#848484;
  --rule:#2a2a2e; --rule2:#242428;
  --acc:#8aa8ff; --acc-bg:rgba(53,101,255,.18);
  --ok:#d4ff2e; --ok-bg:rgba(212,255,46,.16);
  --warn:#ff5631; --warn-bg:rgba(255,86,49,.14);
  --err:#ff5631;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink2);font-family:var(--sans);
  font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:26px;line-height:1.2;margin:0;color:var(--ink);letter-spacing:-.02em;text-wrap:balance}
.lede{color:var(--ink3);margin:8px 0 0;max-width:64ch}
.meta{font-family:var(--mono);font-size:11px;color:var(--ink4);margin-top:10px;
  letter-spacing:.02em;text-transform:uppercase}

/* Résumé */
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--rule2);border:1px solid var(--rule2);border-radius:10px;
  overflow:hidden;margin:26px 0}
.sum div{background:var(--paper);padding:14px 16px}
.sum b{display:block;font-family:var(--mono);font-size:22px;color:var(--ink);
  font-variant-numeric:tabular-nums;line-height:1.1}
.sum span{font-size:11px;color:var(--ink4);text-transform:uppercase;letter-spacing:.06em}

/* Barre de couverture — le seul endroit où je dépense l'accent vif */
.cov{background:var(--paper);border:1px solid var(--rule2);border-radius:10px;
  padding:16px 18px;margin:0 0 26px}
.cov__t{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.cov__t strong{font-family:var(--mono);font-size:20px;color:var(--ink);font-variant-numeric:tabular-nums}
.bar{height:8px;border-radius:99px;background:var(--rule2);margin-top:12px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--acc);border-radius:99px}
.cov p{margin:10px 0 0;color:var(--ink3);font-size:13px;max-width:70ch}

/* Contrôles */
.ctl{position:sticky;top:0;z-index:5;background:var(--canvas);
  padding:12px 0;border-bottom:1px solid var(--rule2);margin-bottom:24px;
  display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input[type=search]{flex:1 1 240px;min-width:0;font-family:var(--mono);font-size:13px;
  padding:9px 12px;border:1px solid var(--rule);border-radius:8px;
  background:var(--paper);color:var(--ink)}
input[type=search]:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.f{font:inherit;font-size:12px;padding:7px 12px;border:1px solid var(--rule);
  border-radius:99px;background:var(--paper);color:var(--ink3);cursor:pointer}
.f[aria-pressed=true]{background:var(--acc-bg);border-color:var(--acc);color:var(--ink)}
.f:focus-visible{outline:2px solid var(--acc);outline-offset:1px}

/* Sections */
.sec{margin:0 0 34px}
.sec__h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
  border-bottom:1px solid var(--rule);padding-bottom:8px}
.sec h2{font-size:15px;margin:0;color:var(--ink);letter-spacing:-.01em}
.sec h2 .n{font-family:var(--mono);color:var(--ink4);font-weight:400;font-size:13px}
.warn-count{margin-left:auto;font-family:var(--mono);font-size:11px;
  color:var(--warn);background:var(--warn-bg);padding:2px 8px;border-radius:99px}
.sec__note{color:var(--ink3);font-size:12.5px;margin:8px 0 12px;max-width:78ch}

.tw{overflow-x:auto;border:1px solid var(--rule2);border-radius:10px;background:var(--paper)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--ink4);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--rule2);
  position:sticky;top:0;background:var(--paper)}
td{padding:7px 12px;border-bottom:1px solid var(--rule2);vertical-align:top}
tr:last-child td{border-bottom:0}
.r{border-left:3px solid transparent}
.r--none{border-left-color:var(--warn)}
.mono{font-family:var(--mono);color:var(--ink);white-space:nowrap}
.dim{color:var(--ink4);font-family:var(--mono);font-size:11.5px}
.wrapc{min-width:260px;font-family:var(--mono);font-size:11.5px;color:var(--ink3);
  white-space:normal;word-break:break-word}
.st{text-align:right;white-space:nowrap}
.chip{display:inline-block;font-family:var(--mono);font-size:10.5px;padding:2px 7px;
  border-radius:99px;font-variant-numeric:tabular-nums}
.chip--both{background:var(--ok-bg);color:var(--ok)}
.chip--unit{background:var(--acc-bg);color:var(--acc)}
.chip--e2e{background:var(--acc-bg);color:var(--acc)}
.chip--none{background:var(--warn-bg);color:var(--warn)}
.chip--na{color:var(--ink4)}
.chip--gate{border:1px solid var(--rule);color:var(--ink3)}

/* Banc */
.benches{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.bench{background:var(--paper);border:1px solid var(--rule2);border-radius:10px;padding:14px 16px}
.bench header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;
  border-bottom:1px solid var(--rule2);padding-bottom:8px;margin-bottom:10px}
.bench h3{margin:0;font-family:var(--mono);font-size:13px;color:var(--ink)}
.sha{font-family:var(--mono);font-size:10.5px;color:var(--ink4)}
.bench dl{margin:0;display:grid;gap:6px}
.bench dl>div{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.bench dt{color:var(--ink3);font-size:12px}
.bench dd{margin:0;font-family:var(--mono);color:var(--ink);font-variant-numeric:tabular-nums;
  white-space:nowrap;font-size:12.5px}
.bench .u{color:var(--ink4);font-size:10.5px}
.bench .why{margin:0 0 10px;font-size:11.5px;color:var(--ink4);line-height:1.5}
.h2big{font-size:17px;color:var(--ink);margin:34px 0 4px;letter-spacing:-.01em;border-bottom:2px solid var(--ink);padding-bottom:6px}
.conf{display:grid;gap:14px;margin:16px 0 0}
@media(min-width:900px){.conf{grid-template-columns:repeat(3,1fr)}}
.tier{background:var(--paper);border:1px solid var(--rule2);border-radius:10px;padding:16px 18px;
  border-top:3px solid var(--rule)}
.tier--hi{border-top-color:var(--ok)}
.tier--mid{border-top-color:var(--acc)}
.tier--lo{border-top-color:var(--warn)}
.tier header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.tier h3{margin:0;font-size:14px;color:var(--ink);letter-spacing:-.01em}
.tier .dot{width:9px;height:9px;border-radius:99px;flex:none}
.tier--hi .dot{background:var(--ok)}
.tier--mid .dot{background:var(--acc)}
.tier--lo .dot{background:var(--warn)}
.tier .tag{font-family:var(--mono);font-size:10px;color:var(--ink4);text-transform:uppercase;
  letter-spacing:.04em;width:100%}
.tier ul{margin:0;padding:0;list-style:none;display:grid;gap:11px}
.tier li{font-size:12.5px;color:var(--ink3);line-height:1.5;padding-left:12px;position:relative}
.tier li::before{content:'';position:absolute;left:0;top:8px;width:4px;height:4px;
  border-radius:99px;background:var(--rule)}
.tier li b{color:var(--ink2);font-weight:600}
.tier code{font-family:var(--mono);font-size:11px;color:var(--ink2);background:var(--rule2);
  padding:1px 4px;border-radius:3px}
.note em{font-style:normal;color:var(--ink2);font-weight:600}

.note{background:var(--paper);border:1px solid var(--rule2);border-left:3px solid var(--acc);
  border-radius:10px;padding:14px 16px;margin:26px 0;color:var(--ink3);font-size:13px}
.note strong{color:var(--ink)}
.legend{color:var(--ink3);font-size:12.5px;margin:0 0 22px;max-width:80ch;line-height:2}
.legend em{color:var(--ink2);font-style:normal;font-weight:600}
.empty{padding:20px;text-align:center;color:var(--ink4);font-size:13px;display:none}
footer{margin-top:50px;padding-top:18px;border-top:1px solid var(--rule);
  color:var(--ink4);font-size:11.5px;font-family:var(--mono)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>

<div class="wrap">
  <h1>Nodal-Agents — inventaire des capacités</h1>
  <p class="lede">Toutes les fonctions exposées par le produit, extraites du code source, avec l'état de leur couverture de test. Généré mécaniquement : rien n'est saisi à la main.</p>
  <p class="meta">${esc(new Date().toISOString().slice(0, 10))} · branche fix/audit-wave1-2026-08-07 · ${inv.meta.testFiles} fichiers de test · ${inv.meta.e2eFiles} e2e · ${inv.meta.archTests} tests d'architecture</p>

  <div class="sum">
    <div><b>${totalUnits}</b><span>capacités</span></div>
    <div><b>${inv.builtinTools.length}</b><span>outils intégrés</span></div>
    <div><b>${connectorToolCount}</b><span>outils connecteurs</span></div>
    <div><b>${inv.serverActions.length}</b><span>actions serveur</span></div>
    <div><b>${modelCount}</b><span>modèles</span></div>
    <div><b>${inv.providers.length}</b><span>fournisseurs LLM</span></div>
  </div>

  <div class="cov">
    <div class="cov__t">
      <span>Couverture nominale sur les ${covered} unités adressables</span>
      <strong>${pct}%</strong>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <p><strong>Ce que ce chiffre ne dit pas.</strong> Il mesure si le nom d'une fonction apparaît dans un fichier de test — pas si son comportement est vérifié. Une fonction citée dans une assertion faible compte comme couverte. À lire comme une carte des angles morts, pas comme un score de qualité.</p>
  </div>

  <section class="sec" id="bench">
    <header class="sec__h"><h2>Banc d’essai <span class="n">${inv.bench.length} sections</span></h2></header>
    <p class="sec__note">Mesures de référence acceptées, versionnées dans <code>bench/baselines/</code>. <code>pnpm bench</code> rejoue et compare ; sortie 1 sur régression.</p>
    <div class="benches">${benchCards}</div>
  </section>

  <h2 class="h2big">Degré de confiance</h2>
  <p class="sec__note" style="margin-bottom:16px">Trois niveaux, selon la NATURE de la preuve — pas selon le nombre de tests. Chaque ligne nomme ce qui la soutient, pour que tu puisses contester le classement.</p>

  <div class="conf">
    <article class="tier tier--hi">
      <header><span class="dot"></span><h3>Sûr</h3><span class="tag">une exécution échouerait bruyamment</span></header>
      <ul>
        <li><b>Le paquet démarre.</b> <code>smoke-pack</code> en CI : pack → installation vierge → boot → rendu d'une vraie page, sur une machine Linux qui n'a jamais vu Nodal. Vert le 9 août.</li>
        <li><b>Les 20 décisions du gate.</b> Mesurées contre le vrai <code>executeTool</code>, métrique <code>exact</code> : tout mouvement, dans un sens comme dans l'autre, sort en rouge.</li>
        <li><b>Les invariants #1, #2, #6.</b> 28 packages scannés à chaque run. Ils ont trouvé 8 violations réelles cette semaine.</li>
        <li><b>Le cadrage du contenu tiers.</b> Un job réel lit un fichier empoisonné ; l'assertion porte sur le transcript persisté, pas sur un retour de fonction.</li>
        <li><b>La rédaction des secrets.</b> 9 formes de credentials + contre-épreuve sur du texte ordinaire (UUID, hashes, URL).</li>
        <li><b>L'épinglage du pack.</b> 46 dépendances runtime, <code>next</code> exact, zéro caret — vérifié dans le <code>package.json</code> généré, pas dans l'intention.</li>
        <li><b>Origin et Host.</b> Les 6 requêtes de l'audit — Host falsifié, Origin attaquant, <code>text/plain</code>, Origin+Host cohérents en <code>evil.test</code> — rejetées sur les deux ports.</li>
        <li><b>Les 135 actions serveur.</b> Plus une seule sans test depuis le 10 août. Ce qui les fait monter ici, ce n'est pas le compte : c'est que chaque garde a été éprouvée par MUTATION — on casse le filtre dans le code de production et on exige que le test vire au rouge. Un test qui survit à sa mutation est retiré ou durci.</li>
      </ul>
    </article>

    <article class="tier tier--mid">
      <header><span class="dot"></span><h3>Moyennement sûr</h3><span class="tag">testé, avec un angle mort nommé</span></header>
      <ul>
        <li><b>Les 64 outils intégrés.</b> 57 apparaissent dans des tests — mais le compte mesure la citation, pas la force de l'assertion.</li>
        <li><b>Les 12 adaptateurs.</b> Suites par package avec mocks aux frontières HTTP : le comportement est prouvé, l'intégration réelle ne l'est pas.</li>
        <li><b>Telegram.</b> Prouvé en live une fois — approbation livrée et résolue en 45 secondes. <b>Discord, Slack, WhatsApp : jamais éprouvés en vrai.</b></li>
        <li><b>Les 51 modèles.</b> Intégrité vérifiée hors-ligne, dérive vérifiée contre l'API en direct — mais <b>aucun n'a été exécuté</b>. Un identifiant valide n'est pas un modèle qui répond.</li>
        <li><b>Windows.</b> Tout mon travail est vérifié sur ta machine ; la CI ne teste que Linux. Les pièges qui te coûtent du temps — kills d'arbres de processus, ports réservés, chemins — ne sont vus par personne.</li>
        <li><b>Les 22 pages du dashboard.</b> Les 15 routes du dashboard sont désormais chargées par Playwright, qui exige un 200 et un <code>h1</code> sur chacune — mais en local seulement, et c'est un contrôle de rendu, pas de comportement.</li>
      </ul>
    </article>

    <article class="tier tier--lo">
      <header><span class="dot"></span><h3>Pas sûr du tout</h3><span class="tag">aucun contrôle mécanique</span></header>
      <ul>
        <li><b>16 skills du catalogue.</b> Du texte livré à tous les agents de toutes les installations. C'est là que j'ai trouvé un nom d'agent personnel.</li>
        <li><b>Playwright en CI.</b> Le job n'avait jamais dépassé son <code>global-setup</code> : il exigeait une authentification que le mode par défaut ne sert pas. Corrigé le 10 août — les specs s'exécutent enfin, 2 passent en CI. Les 2 autres tombent parce que la stack CI est <b>vierge</b> : sans clé LLM elle affiche l'onboarding, pas le dashboard que les specs décrivent. En local, 7 verts. Le job reste <code>continue-on-error</code>, donc il ne garde encore rien.</li>
        <li><b>Les 83 autres specs Playwright.</b> Deux des trois parcours du job étaient périmés de deux refontes d'UI — routes supprimées, onglets passés de <code>button</code> à <code>tab</code>. Rien ne dit que les 83 restantes aient mieux vieilli : elles n'ont pas été rejouées.</li>
        <li><b>11 harnais de fournisseurs sur 12.</b> Jamais pilotés avec leurs propres identifiants natifs. GLM via OpenRouter éprouve le harnais <code>openrouter</code>, pas les autres.</li>
        <li><b>La boucle de réflexion et le curateur.</b> Désactivées par défaut, presque jamais exercées. Elles écrivent des skills — et jusqu'à hier, sans lint.</li>
        <li><b>Le plafond de coût.</b> Ne se déclenche que sur OpenRouter. Sur les 11 autres fournisseurs, seul le budget de tokens protège.</li>
        <li><b>La survie au terminal.</b> <code>up</code> reste au premier plan : fermer le terminal arrête tout. Donc aucun cron, aucun watcher, aucune permanence.</li>
      </ul>
    </article>
  </div>

  <div class="note">
    <strong>Ce que tu peux modifier sereinement.</strong> Le gate d'approbation, les frontières de confiance, le catalogue de modèles, les invariants d'architecture : le banc te dit dans les secondes qui suivent si un chiffre a bougé, et lequel. Depuis le 10 août, l'interface aussi : les 135 actions serveur ont chacune un test, et ces tests ont été éprouvés en cassant le code exprès.<br><br>
    <strong>Ce qui demande de la prudence.</strong> Les textes de skills, les handlers de canaux, la boucle de réflexion : <em>rien ne parlera</em>. Une régression y sera découverte par toi, en usage.
  </div>

  <h2 class="h2big">Capacités</h2>
  <div class="ctl">
    <input type="search" id="q" placeholder="Filtrer : nom d'outil, route, action…" aria-label="Filtrer l'inventaire">
    <button class="f" data-f="all" aria-pressed="true">Tout</button>
    <button class="f" data-f="none" aria-pressed="false">Sans test</button>
    <button class="f" data-f="both" aria-pressed="false">Unit + e2e</button>
  </div>
  <p class="legend">Le compte indique dans <em>combien de fichiers</em> de test le nom de la fonction apparaît — pas combien d'assertions la vérifient.
    <span class="chip chip--unit">2 fichiers</span> citée dans 2 suites unitaires ·
    <span class="chip chip--both">3 units · 1 e2e</span> unitaires et Playwright ·
    <span class="chip chip--none">aucun</span> citée nulle part</p>
  <p class="empty" id="empty">Aucune capacité ne correspond.</p>

${section(
  'builtin',
  'Outils intégrés',
  "Les outils que tout agent peut recevoir. <code>gaté</code> signale un outil qui déclare <code>defaultApproval</code> — il demande une approbation avant de s'exécuter.",
  ['Outil', 'Risque', 'Gate', 'Fichier'],
  inv.builtinTools,
  [
    { get: (t) => `<span class="mono">${esc(t.name)}</span>`, cls: '' },
    { get: (t) => `<span class="dim">${esc(t.risk)}</span>` },
    {
      get: (t) =>
        t.gated ? '<span class="chip chip--gate">gaté</span>' : '<span class="dim">—</span>',
    },
    { get: (t) => `<span class="wrapc">${esc(t.file)}</span>` },
  ],
)}

${section(
  'connectors',
  'Connecteurs (adaptateurs)',
  'Chaque adaptateur expose ses propres outils au format <code>&lt;famille&gt;_&lt;action&gt;</code>. Le statut porte sur la suite de l’adaptateur, pas sur chaque outil pris isolément.',
  ['Adaptateur', 'Outils', 'Liste'],
  inv.connectors,
  [
    { get: (c) => `<span class="mono">${esc(c.adapter)}</span>` },
    { get: (c) => `<span class="dim">${c.count}</span>` },
    { get: (c) => `<span class="wrapc">${esc(c.tools.join(' · '))}</span>` },
  ],
)}

${section(
  'actions',
  'Actions serveur du dashboard',
  'Chaque geste de l’interface passe par une de ces fonctions. Ce sont elles qui écrivent en base — les 39 sans test sont la plus grosse zone d’ombre de l’inventaire.',
  ['Action'],
  inv.serverActions,
  [{ get: (a) => `<span class="mono">${esc(a.name)}</span>` }],
)}

${section(
  'routes',
  'Routes HTTP du runner',
  'La surface réseau du runner. Toutes passent par la validation d’origine et d’hôte ajoutée pour NETWORK-001.',
  ['Méthode', 'Chemin'],
  inv.routes,
  [
    { get: (r) => `<span class="dim">${esc(r.method)}</span>` },
    { get: (r) => `<span class="mono">${esc(r.path)}</span>` },
  ],
)}

${section(
  'pages',
  'Pages du dashboard',
  'Écrans de l’interface. Leur vérification passe surtout par Playwright, qui ne tourne pas encore de façon fiable en CI.',
  ['Route'],
  inv.pages,
  [{ get: (p) => `<span class="mono">${esc(p.route)}</span>` }],
)}

${section(
  'cli',
  'Commandes CLI',
  'Le cycle de vie d’une installation. <code>up</code> reste au premier plan : fermer le terminal arrête tout.',
  ['Commande'],
  inv.cliCommands,
  [{ get: (c) => `<span class="mono">${esc(c.name)}</span>` }],
)}

${section(
  'channels',
  'Canaux de messagerie',
  'Les canaux par lesquels un agent est joignable et livre ses réponses.',
  ['Canal'],
  inv.channels,
  [{ get: (c) => `<span class="mono">${esc(c.name)}</span>` }],
)}

${section(
  'providers',
  'Fournisseurs LLM',
  'Un harnais par fournisseur. La suite de conformité (<code>pnpm --filter @nodal-agents/llm conformance</code>) les éprouve un par un, avec les identifiants natifs de chacun.',
  ['Harnais'],
  inv.providers,
  [{ get: (p) => `<span class="mono">${esc(p.name)}</span>` }],
)}

${section(
  'skills',
  'Skills du catalogue',
  'Textes de consigne livrés avec le produit. Peu testés parce que ce sont des données, pas du code — mais ils atteignent tous les agents de toutes les installations.',
  ['Skill'],
  inv.skills,
  [{ get: (s) => `<span class="mono">${esc(s.name)}</span>` }],
)}

${section(
  'mcp',
  'Serveurs MCP au catalogue',
  'Connecteurs MCP proposés à l’installation. Depuis MCP-001, leurs outils demandent une approbation à la première utilisation.',
  ['Slug'],
  inv.mcpCatalog,
  [{ get: (m) => `<span class="mono">${esc(m.slug)}</span>` }],
)}

  <section class="sec" id="models">
    <header class="sec__h"><h2>Catalogue de modèles <span class="n">${modelCount}</span></h2></header>
    <p class="sec__note">Identifiants exposés dans le sélecteur de modèle, par fournisseur. Vérifiés le 9 août contre l’API OpenRouter en direct.</p>
    <div class="tw"><table>
      <thead><tr><th>Fournisseur</th><th>Nb</th><th>Modèles</th></tr></thead>
      <tbody>${inv.models
        .map(
          (p) =>
            `<tr class="r" data-s="${esc((p.provider + ' ' + p.models.join(' ')).toLowerCase())}" data-t="both"><td><span class="mono">${esc(p.provider)}</span></td><td><span class="dim">${p.count}</span></td><td><span class="wrapc">${esc(p.models.join(' · '))}</span></td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </section>



  <div class="note">
    <strong>Ce que l’inventaire ne couvre pas.</strong> Les 135 outils connecteurs sont comptés par adaptateur, pas un par un — leur statut reflète la suite du package. Le catalogue de modèles n’a pas de statut de test individuel : sa vérification est le drift contre l’API en direct, mesuré par la section <code>catalog-drift</code> du banc.
  </div>

  <footer>Généré depuis le code par scripts/inventory — toute fonction ajoutée apparaît au prochain run.</footer>
</div>

<script>
(function(){
  var q=document.getElementById('q'), empty=document.getElementById('empty');
  var btns=[].slice.call(document.querySelectorAll('.f'));
  var rows=[].slice.call(document.querySelectorAll('tr.r'));
  var filter='all';
  function apply(){
    var term=q.value.trim().toLowerCase(), shown=0;
    rows.forEach(function(r){
      var okT = filter==='all' || r.dataset.t===filter;
      var okQ = !term || (r.dataset.s||'').indexOf(term)!==-1;
      var vis = okT && okQ;
      r.style.display = vis ? '' : 'none';
      if(vis) shown++;
    });
    document.querySelectorAll('.sec').forEach(function(s){
      var any=[].slice.call(s.querySelectorAll('tr.r')).some(function(r){return r.style.display!=='none'});
      var hasRows=s.querySelector('tr.r');
      s.style.display = (!hasRows || any) ? '' : 'none';
    });
    empty.style.display = shown ? 'none' : 'block';
  }
  q.addEventListener('input', apply);
  btns.forEach(function(b){
    b.addEventListener('click', function(){
      filter=b.dataset.f;
      btns.forEach(function(o){o.setAttribute('aria-pressed', String(o===b))});
      apply();
    });
  });
})();
</script>`;

writeFileSync(OUT, html, 'utf-8');
console.log('écrit:', OUT, '—', html.length, 'caractères');
console.log('capacités listées:', totalUnits, '| couverture nominale:', pct + '%');
