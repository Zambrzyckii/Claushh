using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;

namespace Claushh.Api.Tests;

// The account's passkeys (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"): re-authentication, adding through
// Identity's own checks with TestAuthenticator, renaming, removing, their limits and notifications.
public sealed class PasskeyTests(ApiFactory api) : ApiTest(api)
{
    private const string ChromeOnLinux =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    private const string PasskeysPath = "/api/auth/passkeys";
    private const string CreationOptionsPath = "/api/auth/passkeys/creation-options";
    private const string NotAdded = """{"message":"The passkey could not be added. Try again."}""";
    private const string NameRule = """{"message":"A passkey name has 1 to 64 characters and no control characters."}""";

    private sealed record PasskeyBody(string Id, string Name, DateTimeOffset CreatedAt, bool Synced);

    public static TheoryData<string> BadNames => new() { new string('a', 65), "Lap\u0007top", "Lap\u200Etop" };

    private TestAuthenticator Device { get; } = new();

    [Fact]
    public async Task A_wrong_password_gives_403_is_recorded_and_the_eleventh_attempt_gets_429()
    {
        await Client.LoginAsOwnerAsync();
        for (var i = 0; i < 10; i++)
        {
            var wrong = await Client.ReauthenticateAsync("wrong password", "000000");
            Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
            Assert.Equal("", await wrong.Content.ReadAsStringAsync());
        }

        var refused = await Client.ReauthenticateAsync(ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal(TimeSpan.FromMinutes(15), refused.Headers.RetryAfter?.Delta);
        Assert.Equal(11, await Api.LoginAttemptCountAsync());
        Assert.Equal(0, (await Api.LockoutAsync()).AccessFailedCount);
    }

    [Fact]
    public async Task A_wrong_code_after_the_right_password_counts_towards_the_lockout_and_the_fifth_locks_and_notifies()
    {
        var browser = Browser("192.0.2.71");
        await browser.LoginAsOwnerAsync();
        for (var i = 1; i <= 4; i++)
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await browser.ReauthenticateAsync(ApiFactory.Password, Api.WrongTotp())).StatusCode);
            Assert.Equal(i, (await Api.LockoutAsync()).AccessFailedCount);
        }

        Assert.Equal(HttpStatusCode.Forbidden, (await browser.ReauthenticateAsync(ApiFactory.Password, Api.WrongTotp())).StatusCode);
        var lockedAt = Now();

        Assert.NotNull((await Api.LockoutAsync()).LockoutEnd);
        var locked = await browser.ReauthenticateAsync(ApiFactory.Password, Api.CurrentTotp());
        Assert.Equal(HttpStatusCode.TooManyRequests, locked.StatusCode);
        Assert.Equal(TimeSpan.FromMinutes(15), locked.Headers.RetryAfter?.Delta);
        var sent = await Api.Ntfy.UntilAsync(m =>
            m.Title == "Claushh: konto zablokowane" && m.Body.Contains("192.0.2.71", StringComparison.Ordinal));
        Assert.Equal("high", sent[^1].Priority);
        Assert.Contains($"(Chrome · Linux), {lockedAt} UTC.", sent[^1].Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_reused_code_gives_403_and_counts_as_a_wrong_code()
    {
        await Client.LoginAsOwnerAsync();

        var reused = await Client.ReauthenticateAsync(ApiFactory.Password, Api.CurrentTotp());

        Assert.Equal(HttpStatusCode.Forbidden, reused.StatusCode);
        Assert.Equal(1, (await Api.LockoutAsync()).AccessFailedCount);
    }

    [Fact]
    public async Task Re_authentication_makes_the_session_fresh_for_5_minutes_without_extending_it()
    {
        await Client.LoginAsOwnerAsync();
        var before = await Client.MeAsync();
        var stale = await Client.Http.PostAsync(CreationOptionsPath, null);
        Assert.Equal(HttpStatusCode.Forbidden, stale.StatusCode);
        Assert.Equal("", await stale.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.NoContent, (await Client.ReauthenticateAsync(ApiFactory.Password, Api.NextTotp())).StatusCode);

        Assert.Equal(before.ExpiresIn - 30, (await Client.MeAsync()).ExpiresIn);
        Assert.Equal(HttpStatusCode.OK, (await Client.Http.PostAsync(CreationOptionsPath, null)).StatusCode);
        Api.Clock.Advance(TimeSpan.FromMinutes(5) - TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.OK, (await Client.Http.PostAsync(CreationOptionsPath, null)).StatusCode);
        Api.Clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.Forbidden, (await Client.Http.PostAsync(CreationOptionsPath, null)).StatusCode);
    }

    [Fact]
    public async Task Creation_options_ask_for_a_discoverable_passkey_with_user_verification_and_exclude_the_stored_ones()
    {
        await Client.LoginAsOwnerAsync();
        Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(Device)).StatusCode);

        var options = await Client.CreationOptionsAsync();

        Assert.Equal("localhost", options.GetProperty("rp").GetProperty("id").GetString());
        Assert.Equal(ApiFactory.UserName, options.GetProperty("user").GetProperty("name").GetString());
        var selection = options.GetProperty("authenticatorSelection");
        Assert.Equal("required", selection.GetProperty("residentKey").GetString());
        Assert.Equal("required", selection.GetProperty("userVerification").GetString());
        Assert.Equal(300000, options.GetProperty("timeout").GetInt32());
        Assert.Equal(new[] { Device.Id },
            options.GetProperty("excludeCredentials").EnumerateArray().Select(c => c.GetProperty("id").GetString()));
    }

    [Fact]
    public async Task Adding_a_passkey_stores_it_at_the_test_clock_and_notifies_the_owner()
    {
        var browser = Browser("192.0.2.72");
        await browser.LoginAsOwnerAsync();

        var response = await browser.AddPasskeyAsync(Device, "Laptop");
        var time = Now();

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var added = (await response.Content.ReadFromJsonAsync<PasskeyBody>())!;
        Assert.Equal(new PasskeyBody(Device.Id, "Laptop", Api.Clock.GetUtcNow(), false), added);
        Assert.Equal(new[] { added }, await ListAsync(browser));
        var sent = await Api.Ntfy.UntilAsync(m =>
            m.Title == "Claushh: passkey added" && m.Body.Contains("192.0.2.72", StringComparison.Ordinal));
        Assert.Equal("high", sent[^1].Priority);
        Assert.Equal($"Passkey \"Laptop\" added from 192.0.2.72 (Chrome · Linux), {time} UTC. If this was not you: "
            + "create-user --reset-password.", sent[^1].Body);
    }

    [Fact]
    public async Task Synced_is_the_backup_eligible_flag()
    {
        await Client.LoginAsOwnerAsync();
        var synced = new TestAuthenticator { BackupEligible = true };
        Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(synced, "Synced")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(Device, "Bound")).StatusCode);

        Assert.Collection(await ListAsync(Client),
            p => Assert.Equal((synced.Id, "Synced", true), (p.Id, p.Name, p.Synced)),
            p => Assert.Equal((Device.Id, "Bound", false), (p.Id, p.Name, p.Synced)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    public async Task A_missing_or_blank_name_is_the_device(string? name)
    {
        var browser = Browser("192.0.2.74");
        await browser.LoginAsOwnerAsync();

        var response = await browser.AddPasskeyAsync(Device, name);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal("Chrome · Linux", (await response.Content.ReadFromJsonAsync<PasskeyBody>())!.Name);
    }

    [Fact]
    public async Task A_registration_state_works_once_and_expires_after_5_minutes()
    {
        await Client.LoginAsOwnerAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await Client.ReauthenticateAsync(ApiFactory.Password, Api.NextTotp())).StatusCode);
        var options = await Client.CreationOptionsAsync();
        Assert.Equal(HttpStatusCode.Created, (await Client.PostPasskeyAsync(Device.Register(options))).StatusCode);

        // Used: the same options again, with another authenticator.
        await AssertNotAddedAsync(await Client.PostPasskeyAsync(new TestAuthenticator().Register(options)));

        var late = new TestAuthenticator().Register(await Client.CreationOptionsAsync());
        Api.Clock.Advance(TimeSpan.FromMinutes(5));
        await AssertNotAddedAsync(await Client.PostPasskeyAsync(late));
        Assert.Single(await ListAsync(Client));
    }

    [Fact]
    public async Task A_registration_state_belongs_to_the_session_that_asked_for_it()
    {
        await Client.LoginAsOwnerAsync();
        var other = new ApiClient(Api);
        await other.LoginAsOwnerAsync();
        var credential = await other.PreparePasskeyAsync(Device);

        await AssertNotAddedAsync(await Client.PostPasskeyAsync(credential));

        Assert.Equal(HttpStatusCode.Created, (await other.PostPasskeyAsync(credential)).StatusCode);
    }

    [Theory]
    [InlineData("https://evil.test", false, "localhost", true)]
    [InlineData(TestHub.Origin, true, "localhost", true)]
    [InlineData(TestHub.Origin, false, "evil.test", true)]
    [InlineData(TestHub.Origin, false, "localhost", false)]
    public async Task Identity_refuses_a_foreign_origin_a_cross_origin_call_a_foreign_rp_and_no_user_verification(
        string origin, bool crossOrigin, string rpId, bool userVerified)
    {
        await Client.LoginAsOwnerAsync();
        var authenticator = new TestAuthenticator { Origin = origin, CrossOrigin = crossOrigin, RpId = rpId, UserVerified = userVerified };

        await AssertNotAddedAsync(await Client.AddPasskeyAsync(authenticator));

        Assert.Empty(await ListAsync(Client));
    }

    [Fact]
    public async Task A_credential_that_is_already_stored_is_refused()
    {
        await Client.LoginAsOwnerAsync();
        Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(Device)).StatusCode);

        await AssertNotAddedAsync(await Client.AddPasskeyAsync(Device));

        Assert.Single(await ListAsync(Client));
    }

    [Theory]
    [MemberData(nameof(BadNames))]
    public async Task A_bad_name_is_refused_first_and_the_state_stays(string name)
    {
        await Client.LoginAsOwnerAsync();
        var credential = await Client.PreparePasskeyAsync(Device);

        var refused = await Client.PostPasskeyAsync(credential, name);

        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(NameRule, await refused.Content.ReadAsStringAsync());
        var longest = new string('b', 64);
        var added = await Client.PostPasskeyAsync(credential, $"  {longest} ");
        Assert.Equal(HttpStatusCode.Created, added.StatusCode);
        Assert.Equal(longest, (await added.Content.ReadFromJsonAsync<PasskeyBody>())!.Name);
    }

    [Fact]
    public async Task Creation_options_give_409_at_10_passkeys()
    {
        await Client.LoginAsOwnerAsync();
        for (var i = 0; i < 10; i++)
        {
            Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(new TestAuthenticator(), $"Key {i}")).StatusCode);
        }

        var refused = await Client.Http.PostAsync(CreationOptionsPath, null);

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("""{"message":"There are 10 passkeys already. Remove one first."}""", await refused.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Two_adds_prepared_at_9_passkeys_let_only_one_in()
    {
        await Client.LoginAsOwnerAsync();
        for (var i = 0; i < 9; i++)
        {
            Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(new TestAuthenticator(), $"Key {i}")).StatusCode);
        }
        var other = new ApiClient(Api);
        await other.LoginAsOwnerAsync();
        var first = await Client.PreparePasskeyAsync(new TestAuthenticator());
        var second = await other.PreparePasskeyAsync(new TestAuthenticator());

        var responses = await Task.WhenAll(Client.PostPasskeyAsync(first), other.PostPasskeyAsync(second));

        Assert.Equal(new[] { HttpStatusCode.Created, HttpStatusCode.Conflict }, responses.Select(r => r.StatusCode).Order());
        Assert.Equal(10, (await ListAsync(Client)).Length);
    }

    [Fact]
    public async Task Rename_changes_the_name_and_refuses_bad_names_and_unknown_ids()
    {
        await Client.LoginAsOwnerAsync();
        Assert.Equal(HttpStatusCode.Created, (await Client.AddPasskeyAsync(Device)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await RenameAsync(Device.Id, " Phone ")).StatusCode);

        Assert.Equal("Phone", Assert.Single(await ListAsync(Client)).Name);
        var bad = await RenameAsync(Device.Id, "");
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(NameRule, await bad.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await RenameAsync(new TestAuthenticator().Id, "Phone")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await RenameAsync("not*base64url", "Phone")).StatusCode);
    }

    [Fact]
    public async Task Remove_needs_a_fresh_session_and_notifies_the_owner()
    {
        var browser = Browser("192.0.2.73");
        await browser.LoginAsOwnerAsync();
        Assert.Equal(HttpStatusCode.Created, (await browser.AddPasskeyAsync(Device, "Laptop")).StatusCode);
        var path = $"{PasskeysPath}/{Device.Id}";
        Api.Clock.Advance(TimeSpan.FromMinutes(5));

        var stale = await browser.Http.DeleteAsync(path);

        Assert.Equal(HttpStatusCode.Forbidden, stale.StatusCode);
        Assert.Equal("", await stale.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NoContent, (await browser.ReauthenticateAsync(ApiFactory.Password, Api.NextTotp())).StatusCode);
        var time = Now();
        Assert.Equal(HttpStatusCode.NoContent, (await browser.Http.DeleteAsync(path)).StatusCode);
        Assert.Empty(await ListAsync(browser));
        var sent = await Api.Ntfy.UntilAsync(m =>
            m.Title == "Claushh: passkey removed" && m.Body.Contains("192.0.2.73", StringComparison.Ordinal));
        Assert.Equal("high", sent[^1].Priority);
        Assert.Equal($"Passkey \"Laptop\" removed from 192.0.2.73 (Chrome · Linux), {time} UTC. If this was not you: "
            + "create-user --reset-password.", sent[^1].Body);
        Assert.Equal(HttpStatusCode.NotFound, (await browser.Http.DeleteAsync(path)).StatusCode);
    }

    [Fact]
    public async Task Every_passkey_endpoint_needs_a_session_and_every_change_an_xsrf_token()
    {
        await Client.Http.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.GetAsync(PasskeysPath)).StatusCode);
        foreach (var change in Changes())
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.SendAsync(change())).StatusCode);
        }

        await Client.LoginAsOwnerAsync();
        Client.SendXsrf = false;

        foreach (var change in Changes())
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.SendAsync(change())).StatusCode);
        }
        Assert.Equal(1, await Api.LoginAttemptCountAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("127.0.0.1")]
    [InlineData("Localhost")]
    public void The_api_refuses_to_start_without_a_lower_case_host_name_as_server_domain(string domain)
    {
        using var broken = Api.WithWebHostBuilder(builder => builder.UseSetting("Passkeys:ServerDomain", domain));

        var error = Assert.ThrowsAny<Exception>(() => broken.CreateClient()).ToString();

        Assert.Contains("Passkeys:ServerDomain must be the portal's lower-case host name", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Parallel_wrong_codes_in_re_authentication_lock_without_errors()
    {
        var clients = new List<ApiClient>();
        for (var i = 0; i < 8; i++)
        {
            var client = new ApiClient(Api);
            await client.LoginAsOwnerAsync();
            clients.Add(client);
        }
        var code = Api.WrongTotp();

        var responses = await Task.WhenAll(clients.Select(client => client.ReauthenticateAsync(ApiFactory.Password, code)));

        var statuses = responses.Select(r => r.StatusCode).ToList();
        Assert.DoesNotContain(HttpStatusCode.InternalServerError, statuses);
        Assert.Equal(5, statuses.Count(s => s == HttpStatusCode.Forbidden));
        Assert.Equal(3, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
    }

    // Every POST, PATCH and DELETE of the passkey API, each as a new request.
    private Func<HttpRequestMessage>[] Changes() =>
    [
        () => new HttpRequestMessage(HttpMethod.Post, "/api/auth/reauthenticate")
        {
            Content = JsonContent.Create(new { password = ApiFactory.Password, totpCode = "000000" }),
        },
        () => new HttpRequestMessage(HttpMethod.Post, CreationOptionsPath),
        () => new HttpRequestMessage(HttpMethod.Post, PasskeysPath) { Content = JsonContent.Create(new { name = "Laptop" }) },
        () => new HttpRequestMessage(HttpMethod.Patch, $"{PasskeysPath}/{Device.Id}") { Content = JsonContent.Create(new { name = "Laptop" }) },
        () => new HttpRequestMessage(HttpMethod.Delete, $"{PasskeysPath}/{Device.Id}"),
    ];

    private ApiClient Browser(string ip)
    {
        var browser = new ApiClient(Api) { Ip = ip };
        browser.Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", ChromeOnLinux);
        return browser;
    }

    private static async Task<PasskeyBody[]> ListAsync(ApiClient client) =>
        (await client.Http.GetFromJsonAsync<PasskeyBody[]>(PasskeysPath))!;

    private static async Task AssertNotAddedAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(NotAdded, await response.Content.ReadAsStringAsync());
    }

    private Task<HttpResponseMessage> RenameAsync(string id, string name) =>
        Client.Http.PatchAsJsonAsync($"{PasskeysPath}/{id}", new { name });

    // The API's time format in the notifications, from the test clock.
    private string Now() => Api.Clock.GetUtcNow().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
}
