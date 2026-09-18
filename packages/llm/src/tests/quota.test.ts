// quota.test.ts — quota detection logic

import { describe, it, expect, vi } from 'vitest';
import { withRetry, classify429Body } from '../retry';
import { QuotaExhaustedError } from '../errors';

vi.useFakeTimers();

function makeHttpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('quota detection', () => {
  it('converts "quota" 429 to QuotaExhaustedError', async () => {
    const err = makeHttpError(429, 'You have exceeded your quota');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { provider: 'openai', model: 'gpt-4o' })).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts "billing" 429 to QuotaExhaustedError', async () => {
    const err = makeHttpError(429, 'billing limit reached for your account');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { provider: 'anthropic', model: 'claude-3-5-sonnet' }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts "insufficient" 429 to QuotaExhaustedError', async () => {
    const err = makeHttpError(429, 'insufficient_quota: You have run out of credits');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { provider: 'openai', model: 'gpt-4o-mini' }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('plain "rate limit exceeded" 429 is retried, NOT converted to QuotaExhaustedError', async () => {
    // 'rate limit exceeded' is the generic phrasing providers (OpenRouter, Groq,
    // ...) use for an ordinary per-minute throttle — transient, not a billing
    // fatal. Only a message co-occurring with a real quota/billing term (see
    // the test below) should be fatal.
    const err = makeHttpError(429, 'Rate limit exceeded for your current plan');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, {
      provider: 'groq',
      model: 'llama3-8b',
      maxRetries: 2,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('"rate limit exceeded" co-occurring with a real quota/billing term is still fatal', async () => {
    const err = makeHttpError(
      429,
      'Rate limit exceeded — you have exceeded your current quota, check your billing',
    );
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { provider: 'openai', model: 'gpt-4o' })).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('QuotaExhaustedError carries provider, model, reason', async () => {
    const err = makeHttpError(429, 'quota exceeded for entity');
    const fn = vi.fn().mockRejectedValue(err);
    try {
      await withRetry(fn, { provider: 'mistral', model: 'mistral-large' });
    } catch (e) {
      expect(e).toBeInstanceOf(QuotaExhaustedError);
      const qe = e as QuotaExhaustedError;
      expect(qe.provider).toBe('mistral');
      expect(qe.model).toBe('mistral-large');
      expect(qe.reason).toBeTruthy();
    }
  });

  it('plain "Too Many Requests" 429 is retried (not quota)', async () => {
    const err = makeHttpError(429, 'Too Many Requests');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, {
      provider: 'openai',
      model: 'gpt-4o',
      maxRetries: 2,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('QuotaExhaustedError has code "quota_exhausted"', () => {
    const qe = new QuotaExhaustedError('openai', 'gpt-4o', 'test reason');
    expect(qe.code).toBe('quota_exhausted');
  });

  it('QuotaExhaustedError message contains provider and model', () => {
    const qe = new QuotaExhaustedError('anthropic', 'claude-3-5-sonnet', 'ran out');
    expect(qe.message).toContain('anthropic');
    expect(qe.message).toContain('claude-3-5-sonnet');
  });
});

// Le corps EXACT relevé dans `llm_calls` le 18/09/2026 (issue #163), qui a tué
// deux délégations en quota_exhausted alors qu'il demandait de réessayer.
const CORPS_OPENROUTER_163 =
  'openrouter could not verify available credits for this request in time. retry shortly.';

describe('un 429 qui demande de réessayer est passager @cap:parler-a-un-agent/moteur', () => {
  it('le corps exact de #163 est classé passager, cas solde_non_verifie_a_temps', () => {
    expect(classify429Body(CORPS_OPENROUTER_163)).toEqual({
      classe: 'passager',
      cas: 'solde_non_verifie_a_temps',
    });
  });

  it('un vrai refus de facturation reste facturation', () => {
    expect(classify429Body('Insufficient credits. Add more credits to continue.')).toEqual({
      classe: 'facturation',
      cas: 'credits_insuffisants',
    });
    expect(
      classify429Body('You exceeded your current quota, please check your plan and billing'),
    ).toEqual({ classe: 'facturation', cas: 'quota_depasse' });
    expect(classify429Body('Payment required for this model')).toEqual({
      classe: 'facturation',
      cas: 'facturation_requise',
    });
  });

  it('un refus qui dit aussi de réessayer reste un refus', () => {
    // « add credits and try again later » demande un réessai, mais le compte
    // refuse quand même : les trois cas de facturation passent AVANT le réessai
    // générique, et chacun est vérifié, pas seulement le premier.
    expect(classify429Body('Insufficient credits — add credits and try again later.')).toEqual({
      classe: 'facturation',
      cas: 'credits_insuffisants',
    });
    expect(classify429Body('Payment required for this model, please retry')).toEqual({
      classe: 'facturation',
      cas: 'facturation_requise',
    });
    expect(classify429Body('Quota exceeded for this key, try again later')).toEqual({
      classe: 'facturation',
      cas: 'quota_depasse',
    });
  });

  it('un point entre « verify » et « credits » ne renvoie pas en facturation', () => {
    // Le fournisseur peut couper sa phrase : « could not verify. Available
    // credits … ». C'est la même panne, et aucune demande de réessai ne vient
    // la sauver ici — seul le cas passager explicite peut le faire.
    expect(
      classify429Body('openrouter could not verify. available credits for this request: unknown.'),
    ).toEqual({ classe: 'passager', cas: 'solde_non_verifie_a_temps' });
  });

  it('la politique de réessai rejoue le corps de #163 et rend le résultat', async () => {
    const err = makeHttpError(429, CORPS_OPENROUTER_163);
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('réponse du modèle');

    const promise = withRetry(fn, { provider: 'openrouter', model: 'z-ai/glm-5.3' });
    await vi.runAllTimersAsync();

    // Le résultat de la 2e tentative revient à l'appelant : le job vit.
    await expect(promise).resolves.toBe('réponse du modèle');
  });

  it('le corps de #163 ne produit JAMAIS un QuotaExhaustedError, même en échouant', async () => {
    // Même quand toutes les tentatives échouent, la classe de l'erreur dit
    // « réessais épuisés », pas « facturation » : le job n'est pas déclaré mort
    // pour une raison de compte.
    const err = makeHttpError(429, CORPS_OPENROUTER_163);
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { provider: 'openrouter', model: 'z-ai/glm-5.3' });
    const verdict = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const caught = await verdict;
    expect(caught).not.toBeInstanceOf(QuotaExhaustedError);
    expect((caught as Error).name).toBe('RetryExhaustedError');
    // Et il a bien rejoué : 1 tentative initiale + les réessais de la politique.
    expect(fn.mock.calls.length).toBeGreaterThan(1);
  });
});
