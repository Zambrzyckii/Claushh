// The account's passkeys (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"; decisions: docs/PLAN.md, "Backend
// decisions (passkeys)"): re-authentication, the list, adding, renaming, removing, and the passkey login. Identity's
// passkey handler makes the options and checks the credentials; this file keeps its states on the server
// (PasskeyCeremonies), binds them to the session, applies the login gate to adding, the per-IP limit to the login
// options and the notifications to adding and removing, and leaves re-authentication and the passkey login to SignIn.
using System.Buffers.Text;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Claushh.Api.Auth.Notifications;
using Claushh.Api.Web;
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth.Passkeys;

public static class PasskeyEndpoints
{
    public sealed record ReauthenticateRequest(string? Password, string? TotpCode);
    public sealed record AddPasskeyRequest(JsonElement Credential, string? Name);
    public sealed record RenamePasskeyRequest(string? Name);
    public sealed record PasskeyResponse(string Id, string Name, DateTimeOffset CreatedAt, bool Synced);
    public sealed record PasskeyLoginRequest(JsonElement Credential);

    private const int MaxPasskeys = 10;
    private const int MaxNameLength = 64;
    private const string NameRule = "A passkey name has 1 to 64 characters and no control characters.";
    private const string NotAdded = "The passkey could not be added. Try again.";
    private const string LimitReached = "There are 10 passkeys already. Remove one first.";

    public static RouteGroupBuilder MapPasskeyEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapPost("/reauthenticate", Reauthenticate);
        auth.MapGet("/passkeys", List);
        auth.MapPost("/passkeys/creation-options", CreationOptions);
        auth.MapPost("/passkeys", Add);
        auth.MapPatch("/passkeys/{id}", Rename);
        auth.MapDelete("/passkeys/{id}", Remove);
        auth.MapPost("/passkeys/login-options", LoginOptions).AllowAnonymous();
        auth.MapPost("/passkeys/login", Login).AllowAnonymous();
        return api;
    }

    // Password and code again before a passkey is added or removed (the session is then fresh for 5 minutes), inside the
    // login gate with the login's limits. A failure is recorded like a failed login, and a wrong or reused code after the
    // right password counts towards the lockout. 403, not 401: the frontend ends the session on a 401.
    private static async Task<IResult> Reauthenticate(HttpContext http, SignIn signIn)
    {
        var session = SessionAuthenticationHandler.Current(http);
        var client = LoginClient.From(http);
        var body = await JsonBody.ReadAsync<ReauthenticateRequest>(http);
        var outcome = await signIn.ReauthenticateAsync(client, session, body?.Password, body?.TotpCode, http.RequestAborted);
        return outcome.Status switch
        {
            SignInStatus.TooMany => TooManyRequests(http, outcome.RetryAfter),
            SignInStatus.Failed => Results.StatusCode(StatusCodes.Status403Forbidden),
            _ => Results.NoContent(),
        };
    }

    private static async Task<IResult> List(HttpContext http, UserManager<IdentityUser> users)
    {
        var user = await OwnerAsync(users, SessionAuthenticationHandler.Current(http));
        var passkeys = await users.GetPasskeysAsync(user);
        // In the order added: Identity's store returns them in no order of its own.
        return Results.Ok(passkeys
            .OrderBy(p => p.CreatedAt)
            .ThenBy(p => Base64Url.EncodeToString(p.CredentialId), StringComparer.Ordinal)
            .Select(Response));
    }

    // 403 until the session re-authenticated, 409 at the limit. The state stays on the server, keyed by the session.
    private static async Task<IResult> CreationOptions(HttpContext http, UserManager<IdentityUser> users,
        IPasskeyHandler<IdentityUser> passkeys, PasskeyCeremonies ceremonies)
    {
        var session = SessionAuthenticationHandler.Current(http);
        if (!ceremonies.IsFresh(session.Id))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        var user = await OwnerAsync(users, session);
        if ((await users.GetPasskeysAsync(user)).Count >= MaxPasskeys)
        {
            return Results.Conflict(new MessageResponse(LimitReached));
        }
        var options = await passkeys.MakeCreationOptionsAsync(
            new PasskeyUserEntity { Id = user.Id, Name = user.UserName!, DisplayName = user.UserName! }, http);
        ceremonies.SetRegistration(session.Id,
            options.AttestationState ?? throw new InvalidOperationException("Identity gave no attestation state."));
        return Results.Content(options.CreationOptionsJson, "application/json");
    }

    // The name first (the state stays), then inside the login gate, so the limit's count and the insert cannot
    // interleave: the session's state (used once), the limit, Identity's checks and the state's user.
    private static async Task<IResult> Add(HttpContext http, UserManager<IdentityUser> users, LoginGuard guard,
        IPasskeyHandler<IdentityUser> passkeys, PasskeyCeremonies ceremonies, LoginNotifications notifications,
        TimeProvider clock, ILoggerFactory loggers)
    {
        var session = SessionAuthenticationHandler.Current(http);
        var client = LoginClient.From(http);
        var body = await JsonBody.ReadAsync<AddPasskeyRequest>(http);
        if (body is null || body.Credential.ValueKind != JsonValueKind.Object)
        {
            return Results.BadRequest(new MessageResponse(NotAdded));
        }
        // A missing or blank name is the device, e.g. "Chrome · Linux".
        var name = string.IsNullOrWhiteSpace(body.Name) ? DeviceName.From(DeviceName.Stored(client.UserAgent)) : ValidName(body.Name);
        if (name is null)
        {
            return Results.BadRequest(new MessageResponse(NameRule));
        }
        using var gate = await guard.EnterAsync(http.RequestAborted);
        if (gate is null)
        {
            return TooManyRequests(http, (int)LoginGuard.GateWait.TotalSeconds);
        }
        if (ceremonies.TakeRegistration(session.Id) is not { } state)
        {
            return Results.BadRequest(new MessageResponse(NotAdded));
        }
        // Loaded after entering the gate (LoginGuard.EnterAsync), so the count is the current one.
        var user = await OwnerAsync(users, session);
        if ((await users.GetPasskeysAsync(user)).Count >= MaxPasskeys)
        {
            return Results.Conflict(new MessageResponse(LimitReached));
        }
        var result = await passkeys.PerformAttestationAsync(new PasskeyAttestationContext
        {
            HttpContext = http,
            CredentialJson = body.Credential.GetRawText(),
            AttestationState = state,
        });
        if (!result.Succeeded || result.UserEntity.Id != session.UserId)
        {
            loggers.CreateLogger("Claushh.Api.Auth.Passkeys").LogInformation("A passkey was not added: {Reason}",
                result.Failure?.Message ?? "the options were made for another user");
            return Results.BadRequest(new MessageResponse(NotAdded));
        }
        // The same passkey with CreatedAt from TimeProvider instead of the handler's real clock.
        var made = result.Passkey;
        var passkey = new UserPasskeyInfo(made.CredentialId, made.PublicKey, clock.GetUtcNow(), made.SignCount,
            made.Transports, made.IsUserVerified, made.IsBackupEligible, made.IsBackedUp, made.AttestationObject,
            made.ClientDataJson)
        {
            Name = name,
        };
        IdentityResults.ThrowIfFailed(await users.AddOrUpdatePasskeyAsync(user, passkey));
        notifications.PasskeyAdded(name, client.Ip, client.UserAgent);
        return Results.Json(Response(passkey), statusCode: StatusCodes.Status201Created);
    }

    // The name before the id, as when adding.
    private static async Task<IResult> Rename(string id, HttpContext http, UserManager<IdentityUser> users)
    {
        var body = await JsonBody.ReadAsync<RenamePasskeyRequest>(http);
        if (ValidName(body?.Name) is not { } name)
        {
            return Results.BadRequest(new MessageResponse(NameRule));
        }
        var user = await OwnerAsync(users, SessionAuthenticationHandler.Current(http));
        if (CredentialId(id) is not { } credentialId || await users.GetPasskeyAsync(user, credentialId) is not { } passkey)
        {
            return Results.NotFound();
        }
        passkey.Name = name;
        IdentityResults.ThrowIfFailed(await users.AddOrUpdatePasskeyAsync(user, passkey));
        return Results.NoContent();
    }

    // 403 until the session re-authenticated; the passkey is read first, so the notification can name it, and the
    // notification goes out before the removal.
    private static async Task<IResult> Remove(string id, HttpContext http, UserManager<IdentityUser> users,
        PasskeyCeremonies ceremonies, LoginNotifications notifications)
    {
        var session = SessionAuthenticationHandler.Current(http);
        var client = LoginClient.From(http);
        if (!ceremonies.IsFresh(session.Id))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        var user = await OwnerAsync(users, session);
        if (CredentialId(id) is not { } credentialId || await users.GetPasskeyAsync(user, credentialId) is not { } passkey)
        {
            return Results.NotFound();
        }
        notifications.PasskeyRemoved(passkey.Name ?? "", client.Ip, client.UserAgent);
        IdentityResults.ThrowIfFailed(await users.RemovePasskeyAsync(user, credentialId));
        return Results.NoContent();
    }

    // Anonymous: request options for a login with any discoverable passkey; the state stays here under a random id in
    // the challenge cookie. Outside the login gate (it writes no rows), behind the per-IP limit only.
    private static async Task<IResult> LoginOptions(HttpContext http, LoginGuard guard, IPasskeyHandler<IdentityUser> passkeys,
        PasskeyCeremonies ceremonies, AuthCookies cookies)
    {
        var client = LoginClient.From(http);
        if (await guard.IpRetryAfterAsync(client.LimitKey, http.RequestAborted) is { } retryAfter)
        {
            return TooManyRequests(http, retryAfter);
        }
        var options = await passkeys.MakeRequestOptionsAsync(null, http);
        var id = ceremonies.AddLoginChallenge(client.LimitKey,
            options.AssertionState ?? throw new InvalidOperationException("Identity gave no assertion state."));
        cookies.AppendPasskeyChallenge(http.Response, id);
        return Results.Content(options.RequestOptionsJson, "application/json");
    }

    // Anonymous: a passkey login through the login gate and the per-IP limit. Every attempt past them uses up the
    // challenge, expires its cookie and is recorded as a passkey attempt; a passkey login neither counts towards nor
    // resets the lockout. A success creates the same session as a password login.
    private static async Task<IResult> Login(HttpContext http, SignIn signIn, AuthCookies cookies)
    {
        var client = LoginClient.From(http);
        var body = await JsonBody.ReadAsync<PasskeyLoginRequest>(http);
        var outcome = await signIn.PasskeyAsync(http, client, http.Request.Cookies[cookies.Passkey], body?.Credential);
        if (outcome.ChallengeTaken)
        {
            cookies.ExpirePasskeyChallenge(http.Response);
        }
        switch (outcome.Status)
        {
            case SignInStatus.TooMany:
                return TooManyRequests(http, outcome.RetryAfter);
            case SignInStatus.Failed:
                return Results.Unauthorized();
            default:
                cookies.AppendSession(http.Response, outcome.Secret!);
                return Results.NoContent();
        }
    }

    // The session's user as this request loaded it; inside the login gate, loaded after entering it.
    private static async Task<IdentityUser> OwnerAsync(UserManager<IdentityUser> users, Session session) =>
        await users.FindByIdAsync(session.UserId) ?? throw new InvalidOperationException("The session's user does not exist.");

    // Trimmed, 1-64 UTF-16 units, without control or format characters (names go into the phone notifications); null
    // when the name breaks the rule.
    private static string? ValidName(string? name)
    {
        var trimmed = name?.Trim();
        return trimmed is { Length: > 0 and <= MaxNameLength }
            && !trimmed.EnumerateRunes().Any(r => Rune.GetUnicodeCategory(r) is UnicodeCategory.Control or UnicodeCategory.Format)
                ? trimmed
                : null;
    }

    // The credential id from the path (base64url without padding, as the list gives it); null when it is not one.
    private static byte[]? CredentialId(string id) =>
        Base64Url.IsValid(id, out var length) && length is > 0 and <= 1024 ? Base64Url.DecodeFromChars(id) : null;

    private static PasskeyResponse Response(UserPasskeyInfo passkey) =>
        new(Base64Url.EncodeToString(passkey.CredentialId), passkey.Name ?? "", passkey.CreatedAt, passkey.IsBackupEligible);

    // 429 with the whole seconds to wait and an empty body, like the login's.
    private static IResult TooManyRequests(HttpContext http, int seconds)
    {
        http.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
        return Results.StatusCode(StatusCodes.Status429TooManyRequests);
    }
}
