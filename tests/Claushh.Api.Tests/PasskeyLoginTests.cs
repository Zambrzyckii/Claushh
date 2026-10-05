using System.Buffers.Text;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Claushh.Api.Auth;
using Claushh.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

// The passkey login (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"; "Backend" → "Login protection"): the options
// and the challenge cookie, Identity's checks with TestAuthenticator, the login gate, the per-IP limit and the lockout.
public sealed class PasskeyLoginTests(ApiFactory api) : ApiTest(api)
{
    private const string ChromeOnLinux =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    private const string LoginPath = "/api/auth/passkeys/login";
    private const string PasskeyCookie = "__Host-claushh-passkey";

    private sealed record AttemptBody(DateTimeOffset At, string Ip, string Device, bool Success, string Method);

    private TestAuthenticator Device { get; } = new();

    [Fact]
    public async Task Login_options_ask_for_any_discoverable_passkey_with_user_verification_and_set_the_challenge_cookie()
    {
        var response = await Client.LoginOptionsAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var options = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("localhost", options.GetProperty("rpId").GetString());
        Assert.Empty(options.GetProperty("allowCredentials").EnumerateArray());
        Assert.Equal("required", options.GetProperty("userVerification").GetString());
        Assert.Equal(300000, options.GetProperty("timeout").GetInt32());
        Assert.Equal(32, Base64Url.DecodeFromChars(options.GetProperty("challenge").GetString()!).Length);
        var cookie = ApiClient.SetCookie(response, PasskeyCookie);
        foreach (var attribute in new[] { "httponly", "samesite=strict", "secure", "path=/", "max-age=300" })
        {
            Assert.Contains(attribute, cookie, StringComparison.Ordinal);
        }
        Assert.Equal(0, await Api.LoginAttemptCountAsync());
    }

    [Fact]
    public async Task A_valid_assertion_logs_in_records_a_passkey_login_saves_the_counter_and_notifies_with_the_name()
    {
        Device.BackupEligible = true;
        await RegisterAsync();
        Device.BackedUp = true;
        var browser = Browser("192.0.2.81");

        var response = await browser.PasskeyLoginAsync(Device);
        var time = Now();

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains("httponly", ApiClient.SetCookie(response, ApiClient.SessionCookie), StringComparison.Ordinal);
        Assert.Contains("expires=thu, 01 jan 1970", ApiClient.SetCookie(response, PasskeyCookie), StringComparison.Ordinal);
        Assert.Equal(ApiFactory.UserName, (await browser.MeAsync()).UserName);
        var latest = (await HistoryAsync())[0];
        Assert.Equal((true, "passkey", "192.0.2.81"), (latest.Success, latest.Method, latest.Ip));
        var stored = Assert.Single(await Api.PasskeysAsync());
        Assert.Equal(2u, stored.SignCount);
        Assert.True(stored.IsBackedUp);
        var sent = await Api.Ntfy.UntilAsync(m =>
            m.Title == "Claushh: passkey login" && m.Body.Contains("192.0.2.81", StringComparison.Ordinal));
        Assert.Equal("default", sent[^1].Priority);
        Assert.Equal($"Logged in with the passkey \"Laptop\" from 192.0.2.81 (Chrome · Linux), {time} UTC.", sent[^1].Body);
    }

    [Fact]
    public async Task A_login_challenge_works_once_and_expires_after_5_minutes()
    {
        await RegisterAsync();
        var first = Browser("192.0.2.89");
        var options = await OptionsAsync(first);
        var challenge = first.Cookie(PasskeyCookie)!;
        Assert.Equal(HttpStatusCode.NoContent, (await PostLoginAsync(first, Device.Assert(options))).StatusCode);

        // The used challenge again, from a browser that still sends its cookie.
        var replay = Browser("192.0.2.89");
        await replay.Http.GetAsync("/api/auth/me");
        replay.Cookies.Add(ApiClient.BaseAddress, new Cookie(PasskeyCookie, challenge, "/"));
        var replayed = await PostLoginAsync(replay, Device.Assert(options));
        Assert.Equal(HttpStatusCode.Unauthorized, replayed.StatusCode);
        Assert.Contains("expires=thu, 01 jan 1970", ApiClient.SetCookie(replayed, PasskeyCookie), StringComparison.Ordinal);

        // A challenge 5 minutes old.
        var late = Browser("192.0.2.89");
        var lateOptions = await OptionsAsync(late);
        Api.Clock.Advance(TimeSpan.FromMinutes(5));
        var lateResponse = await PostLoginAsync(late, Device.Assert(lateOptions));
        Assert.Equal(HttpStatusCode.Unauthorized, lateResponse.StatusCode);
        Assert.Contains("expires=thu, 01 jan 1970", ApiClient.SetCookie(lateResponse, PasskeyCookie), StringComparison.Ordinal);

        // No challenge cookie at all.
        var none = Browser("192.0.2.89");
        await none.Http.GetAsync("/api/auth/me");
        var noneResponse = await PostLoginAsync(none, Device.Assert(options));
        Assert.Equal(HttpStatusCode.Unauthorized, noneResponse.StatusCode);
        Assert.Contains("expires=thu, 01 jan 1970", ApiClient.SetCookie(noneResponse, PasskeyCookie), StringComparison.Ordinal);

        var attempts = (await HistoryAsync()).Take(4).ToList();
        Assert.Equal(new[] { false, false, false, true }, attempts.Select(a => a.Success));
        Assert.All(attempts, a => Assert.Equal("passkey", a.Method));
    }

    [Theory]
    [InlineData("unknown credential")]
    [InlineData("foreign origin")]
    [InlineData("foreign RP ID")]
    [InlineData("no user verification")]
    [InlineData("corrupted signature")]
    [InlineData("counter not increased")]
    [InlineData("malformed body")]
    public async Task A_failed_assertion_gives_401_is_recorded_as_a_passkey_attempt_and_expires_the_cookie(string failure)
    {
        await RegisterAsync();
        var browser = Browser("192.0.2.88");
        var options = await OptionsAsync(browser);
        var device = failure == "unknown credential" ? new TestAuthenticator { UserHandle = Device.UserHandle } : Device;
        switch (failure)
        {
            case "foreign origin":
                Device.Origin = "https://evil.test";
                break;
            case "foreign RP ID":
                Device.RpId = "evil.test";
                break;
            case "no user verification":
                Device.UserVerified = false;
                break;
            case "corrupted signature":
                Device.CorruptSignature = true;
                break;
            case "counter not increased":
                Device.Counter = 0;
                break;
        }
        object credential = failure == "malformed body" ? "not a credential" : device.Assert(options);
        var count = await Api.LoginAttemptCountAsync();

        var response = await PostLoginAsync(browser, credential);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("", await response.Content.ReadAsStringAsync());
        Assert.Contains("expires=thu, 01 jan 1970", ApiClient.SetCookie(response, PasskeyCookie), StringComparison.Ordinal);
        Assert.Null(browser.Cookie(ApiClient.SessionCookie));
        Assert.Equal(count + 1, await Api.LoginAttemptCountAsync());
        var latest = (await HistoryAsync())[0];
        Assert.Equal((false, "passkey"), (latest.Success, latest.Method));
    }

    [Fact]
    public async Task A_passkey_that_create_user_removed_no_longer_logs_in()
    {
        await RegisterAsync();
        await using (var scope = Api.Services.CreateAsyncScope())
        {
            var terminal = new ScriptedTerminal(Api, _ => "a long enough password", _ => "a long enough password");
            Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<CreateUserCommand>()
                .ResetPasswordAsync(terminal, CancellationToken.None));
        }

        var refused = await Browser("192.0.2.82").PasskeyLoginAsync(Device);

        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
    }

    [Fact]
    public async Task Password_and_passkey_failures_count_together_and_the_limit_refuses_both_passkey_endpoints()
    {
        var browser = Browser("192.0.2.83");
        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await browser.LoginAsync(ApiFactory.UserName, "wrong password", "000000")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await PostLoginAsync(browser, "not a credential")).StatusCode);
        }

        var options = await browser.LoginOptionsAsync();
        var login = await PostLoginAsync(browser, "not a credential");
        var password = await browser.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.CurrentTotp());

        foreach (var refused in new[] { options, login, password })
        {
            Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
            Assert.Equal(TimeSpan.FromMinutes(15), refused.Headers.RetryAfter?.Delta);
            Assert.Equal("", await refused.Content.ReadAsStringAsync());
        }
        Assert.Equal(10, await Api.LoginAttemptCountAsync());
    }

    [Fact]
    public async Task A_running_lock_refuses_password_login_and_re_authentication_but_never_a_passkey_login()
    {
        await RegisterAsync();
        await LockAccountAsync();
        var locked = await Api.LockoutAsync();
        Assert.NotNull(locked.LockoutEnd);

        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Client.ReauthenticateAsync(ApiFactory.Password, Api.NextTotp())).StatusCode);
        var browser = Browser("192.0.2.84");
        Assert.Equal(HttpStatusCode.NoContent, (await browser.PasskeyLoginAsync(Device)).StatusCode);

        Assert.Equal(ApiFactory.UserName, (await browser.MeAsync()).UserName);
        Assert.Equal(locked, await Api.LockoutAsync());
    }

    [Fact]
    public async Task A_passkey_login_neither_counts_towards_nor_resets_the_lockout()
    {
        await RegisterAsync();
        await LockAccountAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(15));
        for (var i = 0; i < 2; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.WrongTotp())).StatusCode);
        }
        var before = await Api.LockoutAsync();
        Assert.Equal((2, "1"), (before.AccessFailedCount, before.LockoutsInARow));
        var browser = Browser("192.0.2.86");

        Device.CorruptSignature = true;
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.PasskeyLoginAsync(Device)).StatusCode);
        Assert.Equal(before, await Api.LockoutAsync());
        Device.CorruptSignature = false;
        Assert.Equal(HttpStatusCode.NoContent, (await browser.PasskeyLoginAsync(Device)).StatusCode);

        Assert.Equal(before, await Api.LockoutAsync());
    }

    // Real time: a password login holds the gate while a test lock on LoginAttempts stops it (as in LoginLimitTests),
    // and the passkey login behind it waits the gate's full 10 s.
    [Fact(Timeout = 60_000)]
    public async Task A_passkey_login_waits_at_most_10_s_for_the_login_before_it_and_keeps_its_challenge()
    {
        var ct = TestContext.Current.CancellationToken;
        await RegisterAsync();
        var browser = Browser("192.0.2.93");
        // Before the table lock: login-options reads LoginAttempts too.
        var credential = Device.Assert(await OptionsAsync(browser));
        var count = await Api.LoginAttemptCountAsync();
        await using var scope = Api.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlRawAsync("""LOCK TABLE "LoginAttempts" IN ACCESS EXCLUSIVE MODE""", ct);
        var held = new ApiClient(Api).LoginAsync(ApiFactory.UserName, "wrong password", "000000"); // stops inside the gate
        await Api.WaitForALockWaitAsync();
        var waited = Stopwatch.StartNew();
        var second = PostLoginAsync(browser, credential);
        HttpResponseMessage refused;
        try
        {
            refused = await second.WaitAsync(TimeSpan.FromSeconds(20), ct);
        }
        finally
        {
            await transaction.RollbackAsync(CancellationToken.None);
        }
        waited.Stop();

        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(10), refused.Headers.RetryAfter?.Delta);
        Assert.Equal("", await refused.Content.ReadAsStringAsync(ct));
        Assert.True(waited.Elapsed >= TimeSpan.FromSeconds(9.5), $"429 after {waited.Elapsed}");
        Assert.Equal(HttpStatusCode.Unauthorized, (await held.WaitAsync(ct)).StatusCode);
        Assert.Equal(count + 1, await Api.LoginAttemptCountAsync());
        Assert.Equal(HttpStatusCode.NoContent, (await PostLoginAsync(browser, credential)).StatusCode);
    }

    [Fact]
    public async Task A_fourth_login_challenge_from_one_address_drops_its_oldest_and_spares_other_addresses()
    {
        await RegisterAsync();
        var elsewhere = Browser("192.0.2.91");
        var elsewhereOptions = await OptionsAsync(elsewhere);
        var tabs = Enumerable.Range(0, 4).Select(_ => Browser("192.0.2.90")).ToList();
        var options = new List<JsonElement>();
        foreach (var tab in tabs)
        {
            options.Add(await OptionsAsync(tab));
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await PostLoginAsync(tabs[0], Device.Assert(options[0]))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await PostLoginAsync(tabs[1], Device.Assert(options[1]))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await PostLoginAsync(tabs[3], Device.Assert(options[3]))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await PostLoginAsync(elsewhere, Device.Assert(elsewhereOptions))).StatusCode);
    }

    [Fact]
    public async Task The_history_shows_the_method_and_a_failed_re_authentication_counts_as_a_password_attempt()
    {
        await RegisterAsync();
        Assert.Equal(HttpStatusCode.Forbidden, (await Client.ReauthenticateAsync("wrong password", "000000")).StatusCode);
        var browser = Browser("192.0.2.92");
        Device.CorruptSignature = true;
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.PasskeyLoginAsync(Device)).StatusCode);
        Device.CorruptSignature = false;
        Assert.Equal(HttpStatusCode.NoContent, (await browser.PasskeyLoginAsync(Device)).StatusCode);

        var response = await Client.Http.GetAsync("/api/auth/logins");

        var json = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"method\":\"passkey\"", json, StringComparison.Ordinal);
        var attempts = JsonSerializer.Deserialize<AttemptBody[]>(json, JsonSerializerOptions.Web)!;
        Assert.Equal(new[] { (true, "passkey"), (false, "passkey"), (false, "password"), (true, "password") },
            attempts.Select(a => (a.Success, a.Method)));
    }

    // The owner logs in with the password (Client) and adds Device as "Laptop".
    private async Task RegisterAsync()
    {
        await Client.LoginAsOwnerAsync();
        Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(Device)).StatusCode);
    }

    private ApiClient Browser(string ip)
    {
        var browser = new ApiClient(Api) { Ip = ip };
        browser.Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", ChromeOnLinux);
        return browser;
    }

    private static async Task<JsonElement> OptionsAsync(ApiClient client)
    {
        var response = await client.LoginOptionsAsync();
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static Task<HttpResponseMessage> PostLoginAsync(ApiClient client, object credential) =>
        client.Http.PostAsJsonAsync(LoginPath, new { credential });

    // The owner's view of the history (Client has the session).
    private async Task<AttemptBody[]> HistoryAsync() =>
        (await Client.Http.GetFromJsonAsync<AttemptBody[]>("/api/auth/logins"))!;

    private string Now() => Api.Clock.GetUtcNow().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
}
