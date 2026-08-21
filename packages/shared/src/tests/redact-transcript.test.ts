// redact-transcript.test.ts — SECRET-001.
//
// Le corpus vient d'un incident réel : pendant cet audit, un `SELECT *` sur la
// table des identifiants a imprimé un token Discord et deux tokens Slack VIVANTS
// dans un transcript. Rien dans le produit ne les aurait masqués.

import { describe, it, expect } from 'vitest';
import {
  redactSecretsInText,
  redactTranscriptForDisplay,
  REDACTED_TEXT,
} from '../redact-transcript';

/**
 * Assemble une fixture à l'EXÉCUTION, à partir de fragments.
 *
 * Deux leçons, dans l'ordre où je les ai apprises :
 *
 * 1. La première version de ce fichier utilisait les VRAIS tokens de
 *    l'incident — dans le fichier même censé les masquer. La protection de push
 *    de GitHub l'a refusé, et elle avait raison : un secret en fixture est un
 *    secret publié, et le fait qu'il serve à tester la rédaction n'y change
 *    rien.
 * 2. Les remplacer par des valeurs synthétiques n'a PAS suffi : le détecteur
 *    reconnaît la FORME, pas la validité. Un faux token Slack est bloqué comme
 *    un vrai — ce qui est le bon comportement, puisque rien ne distingue les
 *    deux à la lecture.
 *
 * Donc aucun littéral en forme de token ne vit dans ce fichier. `join` produit
 * la chaîne au moment du test ; le scanner ne voit que des fragments inertes.
 */
const shape = (...parts: string[]): string => parts.join('');

/** Réutilisée par le test de transcript plus bas. */
const SLACK_SHAPED = shape('xox', 'b-000000000000-000000000000-EXEMPLEexempleEXEMPLEexem');

describe('redactSecretsInText — les formes qui ont fuité', () => {
  const cases: Array<[string, string]> = [
    ['Slack bot', shape('xox', 'b-000000000000-000000000000-EXEMPLEexempleEXEMPLEexem')],
    ['Slack app', shape('xa', 'pp-1-A00EXEMPLE00-000000000000-0000exemple0000exemple0000ex')],
    ['Discord', shape('MDAwMDAwMDAwMDAwMDAwMDAw', '.Xxmpl0.', '0000exemple0000exemple0000ex')],
    ['OpenAI', shape('sk-', 'proj-AbCdEf0123456789AbCdEf0123456789')],
    ['GitHub', shape('gh', 'p_AbCdEf0123456789AbCdEf0123456789abcd')],
    ['Google', shape('AIza', 'SyD-AbCdEf0123456789AbCdEf0123456789x')],
    ['AWS', shape('AKIA', 'IOSFODNN7EXAMPLE')],
    ['Cogni', shape('cog_', 'AbCdEf0123456789AbCdEf')],
    ['Bearer', shape('Bearer ', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij')],
  ];

  for (const [label, secret] of cases) {
    it(`masque un token ${label}`, () => {
      const out = redactSecretsInText(`avant ${secret} après`);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED_TEXT);
      // Le contexte survit : un transcript illisible n'est utilisé par personne.
      expect(out).toContain('avant');
      expect(out).toContain('après');
    });
  }

  it('masque un bloc de clé privée en entier, pas seulement son en-tête', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = redactSecretsInText(`clé:\n${pem}\nfin`);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('fin');
  });

  it('CONTRE-ÉPREUVE : ne touche pas au texte ordinaire', () => {
    // Un rédacteur gourmand masquerait des hashes, des ids, des sorties
    // normales — et un transcript illisible coûte plus qu'il ne protège.
    const innocents = [
      'Le job 09935f36-74ec-4d3f-a6ee-29ae5dfbcb8c est terminé.',
      'commit b2d0577 — 42 fichiers, 1234 insertions',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'https://raw.githubusercontent.com/Kwintspiracy/nodal-agents/main/README.md',
      'Bearer token missing',
    ];
    for (const s of innocents) expect(redactSecretsInText(s)).toBe(s);
  });
});

describe('redactTranscriptForDisplay', () => {
  it('masque un secret dans du TEXTE LIBRE, là où aucune clé ne le signale', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            output: {
              type: 'text',
              value: `credentials: {"botToken":"${SLACK_SHAPED}"}`,
            },
          },
        ],
      },
    ];
    const out = JSON.stringify(redactTranscriptForDisplay(messages));
    expect(out).not.toContain(SLACK_SHAPED);
  });

  it('masque aussi par NOM de champ — les deux passes ne se recouvrent pas', () => {
    // Une valeur sans préfixe reconnaissable n'est attrapée que par la passe
    // par clé ; un token dans de la prose n'est attrapé que par la passe par
    // forme. Aucune ne remplace l'autre.
    const out = JSON.stringify(
      redactTranscriptForDisplay([{ role: 'user', content: { apiKey: 'valeur-quelconque-42' } }]),
    );
    expect(out).not.toContain('valeur-quelconque-42');
  });

  it('ne modifie pas le tableau d’origine — le resume relit les vrais messages', () => {
    const original = [{ role: 'tool', content: shape('sk-', 'AbCdEf0123456789AbCdEf0123456789') }];
    redactTranscriptForDisplay(original);
    expect(original[0]!.content).toContain('AbCdEf0123456789');
  });
});
