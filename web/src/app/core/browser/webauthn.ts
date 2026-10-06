import { Injectable } from '@angular/core';

/**
 * The browser's passkey API (WebAuthn, `navigator.credentials`), extracted into a service so it can be replaced in
 * tests (docs/ARCHITECTURE.md, "Tests"): jsdom has none, and the e2e tests use Chromium's virtual authenticator.
 * The API's options are JSON and the browser parses them (`PublicKeyCredential.parseCreationOptionsFromJSON` and
 * `parseRequestOptionsFromJSON`: Chrome 129, Firefox 119, Safari 18.4); the credential goes back as JSON built here,
 * because some password managers break `PublicKeyCredential.toJSON()`.
 */

/** How a prompt ended without a credential: closed or timed out, refused at this address, already on this device, other. */
export type WebAuthnFailure = 'cancelled' | 'not-here' | 'already-registered' | 'failed';

/** `response` of a new passkey; binary fields in base64url without padding. */
export interface AttestationResponseJson {
  clientDataJSON: string;
  attestationObject: string;
  authenticatorData: string;
  transports: string[];
}

/** `response` of a passkey login; binary fields in base64url without padding. */
export interface AssertionResponseJson {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

/** A public key credential as the API takes it (`credential`, docs/ARCHITECTURE.md, "Authentication" → "Passkeys"). */
export interface PasskeyCredentialJson {
  id: string;
  rawId: string;
  type: string;
  authenticatorAttachment: string | null;
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  response: AttestationResponseJson | AssertionResponseJson;
}

export type WebAuthnResult = { ok: true; credential: PasskeyCredentialJson } | { ok: false; reason: WebAuthnFailure };

@Injectable({ providedIn: 'root' })
export class WebAuthn {
  /** Whether this browser can create and use passkeys from the API's JSON options; false in jsdom and outside a secure context. */
  available(): boolean {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function' &&
      typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function' &&
      typeof navigator !== 'undefined' &&
      navigator.credentials !== undefined
    );
  }

  /** The browser's prompt that creates a passkey from the API's creation options. */
  async create(options: PublicKeyCredentialCreationOptionsJSON): Promise<WebAuthnResult> {
    try {
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
      const credential = await navigator.credentials.create({ publicKey });
      if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
        return { ok: false, reason: 'failed' };
      }
      const response = credential.response;
      return {
        ok: true,
        credential: toJson(credential, {
          clientDataJSON: base64url(response.clientDataJSON),
          attestationObject: base64url(response.attestationObject),
          authenticatorData: base64url(response.getAuthenticatorData()),
          transports: response.getTransports()
        })
      };
    } catch (error) {
      return { ok: false, reason: failure(error, 'create') };
    }
  }

  /** The browser's prompt that logs in with a passkey, from the API's request options. */
  async get(options: PublicKeyCredentialRequestOptionsJSON): Promise<WebAuthnResult> {
    try {
      const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
      const credential = await navigator.credentials.get({ publicKey });
      if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
        return { ok: false, reason: 'failed' };
      }
      const response = credential.response;
      return {
        ok: true,
        credential: toJson(credential, {
          clientDataJSON: base64url(response.clientDataJSON),
          authenticatorData: base64url(response.authenticatorData),
          signature: base64url(response.signature),
          userHandle: response.userHandle ? base64url(response.userHandle) : null
        })
      };
    } catch (error) {
      return { ok: false, reason: failure(error, 'get') };
    }
  }
}

function toJson(credential: PublicKeyCredential, response: PasskeyCredentialJson['response']): PasskeyCredentialJson {
  return {
    id: credential.id,
    rawId: base64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response
  };
}

/** The browser's error as a reason; a closed or timed-out prompt is a `NotAllowedError`. */
function failure(error: unknown, ceremony: 'create' | 'get'): WebAuthnFailure {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') {
    return 'cancelled';
  }
  if (name === 'SecurityError') {
    return 'not-here';
  }
  if (name === 'InvalidStateError' && ceremony === 'create') {
    return 'already-registered';
  }
  return 'failed';
}

/** Bytes as base64url without padding, the form the API reads. */
function base64url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
