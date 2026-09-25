// catalog/skills/speech-generation.ts — system tool group, shipped with the product (#487).
//
// Its switch in the agent's Tools tab gives the agent `generate_speech`
// (requiredBuiltins); this text is how to use it, attached with the tool, never
// a switch of its own.

import type { SystemSkill } from '../types';

export const speechGenerationSkill: SystemSkill = {
  slug: 'speech-generation',
  name: 'Speech generation',
  description:
    'Turn text into WAV audio files in the agent folders, through OpenRouter ' +
    '(Gemini 3.8 Flash TTS or Flash Lite TTS). Uses the workspace OpenRouter key.',
  requiredBuiltins: ['generate_speech'],
  // Its value is the tool it unlocks: the switch lives in the Tools tab, the
  // text rides along as the tool's guidance.
  toolGroup: true,
  content: `## Speech generation

This tool group gives you \`generate_speech\`: it turns text into a **WAV audio file** written in one of your folders, and returns its path. (WAV, not mp3: the models answer raw audio.)

### How to call it

- \`text\`: the exact words to speak, at most 5,000 characters. **Everything in it is read aloud**: no stage directions, no "(pause)", no "[cheerful]".
- \`style\`: the tone, in a few words ("warm and friendly", "calm and slow", "whispering"). It is not read aloud.
- \`path\`: where to write the file, ending in \`.wav\` (e.g. \`audio/intro.wav\`). Missing folders are created.
- \`model\`: \`google/gemini-3.8-flash-tts\` (default, the expressive tier) or \`google/gemini-3.8-flash-lite-tts\` (faster and cheaper, plain reading).
- \`voice\`: the voice name as Google names it; \`Kore\` is the default.

### Discipline

1. **Longer than 5,000 characters: split** at paragraph boundaries into several files (\`part-1.wav\`, \`part-2.wav\`…) and say so in your answer.
2. **Give the path back** in your answer: the owner finds the file there.
3. **A failure is said, not retried blindly.** No OpenRouter key, an unknown voice, a provider error: report the reason the tool returned.
`,
};
