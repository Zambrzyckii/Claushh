import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { AuthService, LoginResult } from '../../core/auth/auth.service';
import { safeReturnUrl } from '../../core/auth/return-url';

/**
 * Login screen: login, password and a 6-digit TOTP code from the phone app.
 * Error messages are deliberately generic: they do not reveal which field was wrong.
 * After a failed attempt the password and the code are cleared from the form.
 */
@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;

  protected readonly form = inject(NonNullableFormBuilder).group({
    userName: ['', [Validators.required, Validators.maxLength(256)]],
    password: ['', [Validators.required, Validators.maxLength(1024)]],
    totpCode: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]]
  });

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = noticeFor(this.query.get('reason'), this.query.get('logout'));

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.error.set(null);
    const result = await this.auth.login(this.form.getRawValue());

    if (result.ok) {
      this.form.reset();
      await this.router.navigateByUrl(safeReturnUrl(this.query.get('returnUrl')));
      return;
    }

    this.form.controls.password.reset();
    this.form.controls.totpCode.reset();
    this.error.set(errorMessage(result));
    this.submitting.set(false);
  }
}

function errorMessage(result: Extract<LoginResult, { ok: false }>): string {
  switch (result.reason) {
    case 'invalid':
      return 'Nieprawidłowe dane logowania.';
    case 'rate-limited':
      return result.retryAfterSeconds
        ? `Zbyt wiele prób. Spróbuj ponownie za ${result.retryAfterSeconds} s.`
        : 'Zbyt wiele prób. Spróbuj ponownie później.';
    case 'network':
      return 'Brak połączenia z serwerem.';
    case 'server':
      return 'Błąd serwera. Spróbuj ponownie.';
  }
}

function noticeFor(reason: string | null, logout: string | null): { text: string; warning: boolean } | null {
  if (logout === 'unconfirmed') {
    return {
      text:
        'Dane w tej przeglądarce zostały wyczyszczone, ale serwer nie potwierdził zakończenia sesji. ' +
        'Jeśli to obcy komputer, zaloguj się i wyloguj ponownie, gdy połączenie wróci.',
      warning: true
    };
  }
  if (logout === 'ok') {
    return { text: 'Wylogowano.', warning: false };
  }
  if (reason === 'expired') {
    return { text: 'Sesja wygasła. Zaloguj się ponownie.', warning: false };
  }
  return null;
}
