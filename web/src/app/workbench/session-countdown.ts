import { Component, inject, input } from '@angular/core';

import { SessionTimer } from '../core/auth/session-timer';

/**
 * The session countdown of both bars (docs/ARCHITECTURE.md, sections "Layout" and "Phone layout"). It shows the time
 * left until the session ends (nothing without an expiry time from the server), and in the last two minutes the warning
 * colour with "Extend". The status bar on a desktop adds a clock and a tooltip, the title bar on a phone has neither.
 * The host is `display: contents`, so the span and the button stay items of the parent bar's flex row.
 */
@Component({
  selector: 'app-session-countdown',
  templateUrl: './session-countdown.html',
  styleUrl: './session-countdown.scss'
})
export class SessionCountdown {
  protected readonly timer = inject(SessionTimer);

  readonly bar = input.required<'topbar' | 'statusbar'>();
}
