// The account's passkeys (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"; decisions: docs/PLAN.md, "Backend
// decisions (passkeys)"): re-authentication, the list, adding, renaming, removing, and the passkey login. Identity's
// passkey handler makes the options and checks the credentials; this file keeps its states on the server
// (PasskeyCeremonies), binds them to the session, and applies the login gate, the limits and the notifications.
using System.Buffers.Text;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Claushh.Api.Notifications;
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

public static class PasskeyEndpoints
{
    public sealed record ReauthenticateRequest(string? Password, string? TotpCode);
    public sealed record AddPasskeyRequest(JsonElement Credential, string? Name);
    public sealed record RenamePasskeyRequest(string? Name);
    public sealed record PasskeyResponse(string Id, string Name, DateTimeOffset CreatedAt, bool Synced);
    public sealed record MessageResponse(string Message);
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
    private static async Task<IResult> Reauthenticate(HttpContext http, UserManager<IdentityUser> users, LoginGuard guard,
        TotpVerifier totp, PasskeyCeremonies ceremonies, LoginNotifications notifications)
    {
        var session = SessionAuthenticationHandler.Current(http);
        var (ip, limitKey) = LoginGuard.ClientIp(http.Connection.RemoteIpAddress);
        var userAgent = http.Request.Headers.UserAgent.ToString();
        var body = await ReadJsonAsync<ReauthenticateRequest>(http);
        using var gate = await guard.EnterAsync(http.RequestAborted);
        if (gate is null)
        {
            return TooManyRequests(http, (int)LoginGuard.GateWait.TotalSeconds);
        }
        if (await guard.RetryAfterAsync(limitKey, http.RequestAborted) is { } retryAfter)
        {
            return TooManyRequests(http, retryAfter);
        }
        var user = await CheckPasswordAsync(users, session.UserId, body);
        var success = user is not null && await totp.VerifyAsync(user, body?.TotpCode ?? "");
        if (user is null || !success)
        {
            // Not the request's token: an attempt whose client went away is still recorded and counted.
            await guard.RecordAsync(false, LoginMethods.Password, ip, limitKey, userAgent, CancellationToken.None);
            if (user is not null && await guard.CodeFailedAsync(user) is { } lockout)
            {
                notifications.AccountLocked(lockout, ip, userAgent);
            }
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        await guard.SucceededAsync(user);
        ceremonies.MarkFresh(session.Id);
        return Results.NoContent();
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
        var (ip, _) = LoginGuard.ClientIp(http.Connection.RemoteIpAddress);
        var userAgent = http.Request.Headers.UserAgent.ToString();
        var body = await ReadJsonAsync<AddPasskeyRequest>(http);
        if (body is null || body.Credential.ValueKind != JsonValueKind.Object)
        {
            return Results.BadRequest(new MessageResponse(NotAdded));
        }
        // A missing or blank name is the device, e.g. "Chrome · Linux".
        var name = string.IsNullOrWhiteSpace(body.Name) ? DeviceName.From(DeviceName.Stored(userAgent)) : ValidName(body.Name);
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
        ThrowIfFailed(await users.AddOrUpdatePasskeyAsync(user, passkey));
        notifications.PasskeyAdded(name, ip, userAgent);
        return Results.Json(Response(passkey), statusCode: StatusCodes.Status201Created);
    }

    // The name before the id, as when adding.
    private static async Task<IResult> Rename(string id, HttpContext http, UserManager<IdentityUser> users)
    {
        var body = await ReadJsonAsync<RenamePasskeyRequest>(http);
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
        ThrowIfFailed(await users.AddOrUpdatePasskeyAsync(user, passkey));
        return Results.NoContent();
    }

    // 403 until the session re-authenticated; the passkey is read first, so the notification can name it, and the
    // notification goes out before the removal.
    private static async Task<IResult> Remove(string id, HttpContext http, UserManager<IdentityUser> users,
        PasskeyCeremonies ceremonies, LoginNotifications notifications)
    {
        var session = SessionAuthenticationHandler.Current(http);
        if (!ceremonies.IsFresh(session.Id))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        var user = await OwnerAsync(users, session);
        if (CredentialId(id) is not { } credentialId || await users.GetPasskeyAsync(user, credentialId) is not { } passkey)
        {
            return Results.NotFound();
        }
        var (ip, _) = LoginGuard.ClientIp(http.Connection.RemoteIpAddress);
        notifications.PasskeyRemoved(passkey.Name ?? "", ip, http.Request.Headers.UserAgent.ToString());
        ThrowIfFailed(await users.RemovePasskeyAsync(user, credentialId));
        return Results.NoContent();
    }

    // Anonymous: request options for a login with any discoverable passkey; the state stays here under a random id in
    // the challenge cookie. Outside the login gate (it writes no rows), behind the per-IP limit only.
    private static async Task<IResult> LoginOptions(HttpContext http, LoginGuard guard, IPasskeyHandler<IdentityUser> passkeys,
        PasskeyCeremonies ceremonies, AuthCookies cookies)
    {
        var (_, limitKey) = LoginGuard.ClientIp(http.Connection.RemoteIpAddress);
        if (await guard.IpRetryAfterAsync(limitKey, http.RequestAborted) is { } retryAfter)
        {
            return TooManyRequests(http, retryAfter);
        }
        var options = await passkeys.MakeRequestOptionsAsync(null, http);
        var id = ceremonies.AddLoginChallenge(limitKey,
            options.AssertionState ?? throw new InvalidOperationException("Identity gave no assertion state."));
        cookies.AppendPasskeyChallenge(http.Response, id);
        return Results.Content(options.RequestOptionsJson, "application/json");
    }

    // Anonymous: a passkey login through the login gate and the per-IP limit. Every attempt past them uses up the
    // challenge, expires its cookie and is recorded as a passkey attempt; a passkey login neither counts towards nor
    // resets the lockout. A success creates the same session as a password login.
    private static async Task<IResult> Login(HttpContext http, UserManager<IdentityUser> users, LoginGuard guard,
        IPasskeyHandler<IdentityUser> passkeys, PasskeyCeremonies ceremonies, SessionService sessions, AuthCookies cookies,
        LoginNotifications notifications, ILoggerFactory loggers)
    {
        var log = loggers.CreateLogger("Claushh.Api.Auth.PasskeyLogin");
        var (ip, limitKey) = LoginGuard.ClientIp(http.Connection.RemoteIpAddress);
        var userAgent = http.Request.Headers.UserAgent.ToString();
        var body = await ReadJsonAsync<PasskeyLoginRequest>(http);
        using var gate = await guard.EnterAsync(http.RequestAborted);
        if (gate is null)
        {
            // Not recorded, like every 429; the challenge stays for a retry.
            log.LogInformation("Passkey login from {Ip} did not start within {Seconds} s", ip, LoginGuard.GateWait.TotalSeconds);
            return TooManyRequests(http, (int)LoginGuard.GateWait.TotalSeconds);
        }
        if (await guard.IpRetryAfterAsync(limitKey, http.RequestAborted) is { } retryAfter)
        {
            return TooManyRequests(http, retryAfter);
        }
        var state = ceremonies.TakeLoginChallenge(http.Request.Cookies[cookies.Passkey]);
        cookies.ExpirePasskeyChallenge(http.Response);
        var result = state is null || body is not { Credential.ValueKind: JsonValueKind.Object }
            ? null
            : await passkeys.PerformAssertionAsync(new PasskeyAssertionContext
            {
                HttpContext = http,
                CredentialJson = body.Credential.GetRawText(),
                AssertionState = state,
            });
        // Not the request's token: an attempt whose client went away is still recorded and counted.
        await guard.RecordAsync(result?.Succeeded == true, LoginMethods.Passkey, ip, limitKey, userAgent, CancellationToken.None);
        if (result is null || !result.Succeeded)
        {
            log.LogInformation("Passkey login from {Ip} failed: {Reason}", ip,
                result?.Failure?.Message ?? "no challenge or no credential");
            return Results.Unauthorized();
        }
        // The new sign count and backup state: Identity's handler leaves saving them to the caller.
        ThrowIfFailed(await users.AddOrUpdatePasskeyAsync(result.User, result.Passkey));
        var (_, secret) = await sessions.CreateAsync(result.User, userAgent, ip, http.RequestAborted);
        cookies.AppendSession(http.Response, secret);
        log.LogInformation("Passkey login of {UserName} from {Ip}", result.User.UserName, ip);
        notifications.PasskeyLoggedIn(result.Passkey.Name ?? "", ip, userAgent);
        return Results.NoContent();
    }

    // The session's user as this request loaded it; inside the login gate, loaded after entering it.
    private static async Task<IdentityUser> OwnerAsync(UserManager<IdentityUser> users, Session session) =>
        await users.FindByIdAsync(session.UserId) ?? throw new InvalidOperationException("The session's user does not exist.");

    // The user when the body has a password and a 6-character code and the password is right (TOTP on); null otherwise.
    private static async Task<IdentityUser?> CheckPasswordAsync(UserManager<IdentityUser> users, string userId,
        ReauthenticateRequest? body)
    {
        if (body is not { Password: { Length: > 0 and <= 1024 } password, TotpCode.Length: 6 }
            || await users.FindByIdAsync(userId) is not { } user)
        {
            return null;
        }
        return user.TwoFactorEnabled && await users.CheckPasswordAsync(user, password) ? user : null;
    }

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

    // null for a body that is missing, not JSON or of the wrong shape. Read by hand, as in AuthEndpoints.Logout: with an
    // inferred JSON body, routing skips the endpoint for a request without a JSON content type, and the catch-all /api
    // route would answer 404 instead.
    private static async Task<T?> ReadJsonAsync<T>(HttpContext http) where T : class
    {
        if (!http.Request.HasJsonContentType())
        {
            return null;
        }
        try
        {
            return await http.Request.ReadFromJsonAsync<T>(http.RequestAborted);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static void ThrowIfFailed(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }
}
