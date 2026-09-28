import { Component } from '@angular/core';

/**
 * Login screen: password + TOTP code from the phone app.
 * For now only the form, not connected to the API (stage 1, see docs/PLAN.md).
 */
@Component({
  selector: 'app-login',
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class Login {}
