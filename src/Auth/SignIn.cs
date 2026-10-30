// The login gate's sequence for the three ways in (docs/ARCHITECTURE.md, "Backend", "Login protection"): password
// login, re-authentication and passkey login. Each runs the gate, its limits, the credential check, the attempt
// record, the lockout and the notifications in its own order, with deliberate differences. The endpoints only turn the
// outcome into cookies, Retry-After and status codes.
using Claushh.Api.Auth.Notifications;
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

// How a sign-in ended. TooMany carries the Retry-After seconds, Succeeded the new session's secret, and ChallengeTaken
// says that a passkey login used up its challenge.
public enum SignInStatus { Succeeded, Failed, TooMany }

public sealed record SignInOutcome(SignInStatus Status, int RetryAfter = 0, string? Secret = null, bool ChallengeTaken = false);

public sealed class SignIn(UserManager<IdentityUser> users, LoginGuard guard, TotpVerifier totp, SessionService sessions,
    LoginNotifications notifications, ILoggerFactory loggers)
{
    private static readonly IdentityUser DummyUser = new();
    private static string? _dummyHash;

    public async Task<SignInOutcome> PasswordAsync(LoginClient client, string? userName, string? password, string? totpCode,
        CancellationToken ct)
    {
        var log = loggers.CreateLogger("Claushh.Api.Auth.Login");
        using var gate = await guard.EnterAsync(ct);
        if (gate is null)
        {
            // Not recorded, like every 429.
            log.LogInformation("Login from {Ip} did not start within {Seconds} s", client.Ip, LoginGuard.GateWait.TotalSeconds);
            return new SignInOutcome(SignInStatus.TooMany, RetryAfter: (int)LoginGuard.GateWait.TotalSeconds);
        }
        if (await guard.RetryAfterAsync(client.LimitKey, ct) is { } retryAfter)
        {
            return new SignInOutcome(SignInStatus.TooMany, RetryAfter: retryAfter);
        }
        // CheckPasswordAsync returns a user only when TotpCode has 6 characters.
        var user = await CheckPasswordAsync(users, userName, password, totpCode);
        var success = user is not null && await totp.VerifyAsync(user, totpCode!);
        // Not the request's token: an attempt whose client went away is still recorded and counted.
        await guard.RecordAsync(success, LoginMethods.Password, client.Ip, client.LimitKey, client.UserAgent, CancellationToken.None);
        if (user is null || !success)
        {
            // The password was right: only wrong or reused codes count towards the lockout. Queuing does not wait for ntfy.
            if (user is not null && await guard.CodeFailedAsync(user) is { } lockout)
            {
                notifications.AccountLocked(lockout, client.Ip, client.UserAgent);
            }
            // No user name: it is unvalidated input (newlines, any length, sometimes a mistyped password).
            log.LogInformation("Failed login from {Ip}", client.Ip);
            return new SignInOutcome(SignInStatus.Failed);
        }
        await guard.SucceededAsync(user);
        var (_, secret) = await sessions.CreateAsync(user, client.UserAgent, client.Ip, ct);
        log.LogInformation("Login of {UserName} from {Ip}", user.UserName, client.Ip);
        notifications.LoggedIn(client.Ip, client.UserAgent);
        return new SignInOutcome(SignInStatus.Succeeded, Secret: secret);
    }

    // The user when the fields have valid lengths, the name and password are right and TOTP is on; null otherwise.
    // An unknown user still costs one password hash, so the response time does not reveal whether the name exists.
    private static async Task<IdentityUser?> CheckPasswordAsync(UserManager<IdentityUser> users, string? userName,
        string? password, string? totpCode)
    {
        if (userName is not { Length: > 0 and <= 256 }
            || password is not { Length: > 0 and <= 1024 }
            || totpCode is not { Length: 6 })
        {
            return null;
        }
        var user = await users.FindByNameAsync(userName);
        if (user is null)
        {
            _dummyHash ??= users.PasswordHasher.HashPassword(DummyUser, "dummy password for timing");
            users.PasswordHasher.VerifyHashedPassword(DummyUser, _dummyHash, password);
            return null;
        }
        return user.TwoFactorEnabled && await users.CheckPasswordAsync(user, password) ? user : null;
    }
}
