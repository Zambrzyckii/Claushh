using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class SessionListTests(ApiFactory api) : ApiTest(api)
{
    private const string ChromeOnLinux =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    private sealed record SessionBody(Guid Id, bool Current, string Device, string Ip, DateTimeOffset CreatedAt, DateTimeOffset LastActivityAt);
    private sealed record AttemptBody(DateTimeOffset At, string Ip, string Device, bool Success);

    [Fact]
    public async Task Lists_active_sessions_newest_first_with_this_one_marked()
    {
        var chrome = new ApiClient(Api) { Ip = "198.51.100.7" };
        chrome.Http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", ChromeOnLinux);
        var chromeMe = await chrome.LoginAsOwnerAsync();
        var ended = new ApiClient(Api);
        await ended.LoginAsOwnerAsync();
        await ended.Http.PostAsync("/api/auth/logout", null);
        var me = await Client.LoginAsOwnerAsync();

        var sessions = (await Client.Http.GetFromJsonAsync<SessionBody[]>("/api/auth/sessions"))!;

        Assert.Collection(sessions,
            s =>
            {
                Assert.Equal(me.SessionId, s.Id);
                Assert.True(s.Current);
                // This client sends no User-Agent at all.
                Assert.Equal("Browser · unknown system", s.Device);
            },
            s =>
            {
                Assert.Equal(chromeMe.SessionId, s.Id);
                Assert.False(s.Current);
                Assert.Equal("Chrome · Linux", s.Device);
                Assert.Equal("198.51.100.7", s.Ip);
                Assert.True(s.CreatedAt < sessions[0].CreatedAt);
            });
    }

    [Fact]
    public async Task Revoke_others_ends_every_other_session_and_keeps_this_one()
    {
        var first = new ApiClient(Api);
        await first.LoginAsOwnerAsync();
        var second = new ApiClient(Api);
        await second.LoginAsOwnerAsync();
        var me = await Client.LoginAsOwnerAsync();

        var response = await Client.Http.PostAsync("/api/auth/sessions/revoke-others", null);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await first.Http.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await second.Http.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(me.SessionId, (await Client.MeAsync()).SessionId);
    }

    [Fact]
    public async Task Revoke_others_needs_an_xsrf_token()
    {
        var other = new ApiClient(Api);
        await other.LoginAsOwnerAsync();
        await Client.LoginAsOwnerAsync();
        Client.SendXsrf = false;

        var refused = await Client.Http.PostAsync("/api/auth/sessions/revoke-others", null);

        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await other.Http.GetAsync("/api/auth/me")).StatusCode);
        Client.SendXsrf = true;
        var accepted = await Client.Http.PostAsync("/api/auth/sessions/revoke-others", null);
        Assert.Equal(HttpStatusCode.NoContent, accepted.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await other.Http.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Login_history_is_newest_first_and_holds_no_user_names()
    {
        var stranger = new ApiClient(Api) { Ip = "203.0.113.9" };
        await stranger.LoginAsync("intruder", "wrong password", "000000");
        await Client.LoginAsOwnerAsync();

        var response = await Client.Http.GetAsync("/api/auth/logins");
        var json = await response.Content.ReadAsStringAsync();
        var attempts = (await response.Content.ReadFromJsonAsync<AttemptBody[]>())!;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain("intruder", json);
        Assert.DoesNotContain(ApiFactory.UserName, json);
        Assert.Collection(attempts,
            a => Assert.True(a.Success),
            a =>
            {
                Assert.False(a.Success);
                Assert.Equal("203.0.113.9", a.Ip);
            });
    }

    [Fact]
    public async Task Login_history_holds_the_last_20_attempts()
    {
        for (var i = 0; i < 21; i++)
        {
            await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp());
        }

        var attempts = (await Client.Http.GetFromJsonAsync<AttemptBody[]>("/api/auth/logins"))!;

        Assert.Equal(20, attempts.Length);
        Assert.Equal(Api.Clock.GetUtcNow(), attempts[0].At);
    }

    [Fact]
    public async Task Session_list_and_history_need_a_session()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.GetAsync("/api/auth/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.GetAsync("/api/auth/logins")).StatusCode);
    }
}
