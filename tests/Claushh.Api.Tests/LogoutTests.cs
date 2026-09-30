using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class LogoutTests(ApiFactory api) : ApiTest(api)
{
    [Fact]
    public async Task Logout_ends_the_session_on_the_server_and_expires_the_cookies()
    {
        await Client.LoginAsOwnerAsync();
        var secret = Client.Cookie(ApiClient.SessionCookie)!;

        var response = await Client.Http.PostAsync("/api/auth/logout", null);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        foreach (var name in new[] { ApiClient.SessionCookie, "__Host-claushh-af", "XSRF-TOKEN" })
        {
            Assert.Contains("expires=thu, 01 jan 1970", ApiClient.SetCookie(response, name));
        }
        // The old cookie sent again from another browser: the session is gone on the server, not only in this browser.
        var replay = new ApiClient(Api);
        replay.Cookies.Add(ApiClient.BaseAddress, new Cookie(ApiClient.SessionCookie, secret, "/"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await replay.Http.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Logout_with_the_own_session_id_ends_it()
    {
        var me = await Client.LoginAsOwnerAsync();

        var response = await Client.Http.PostAsJsonAsync("/api/auth/logout", new { sessionId = me.SessionId.ToString() });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Theory]
    [InlineData("0b6c8b7e-3c1f-4c55-9d2a-8f1e2d3c4b5a")]
    [InlineData("s1")]
    public async Task Logout_with_another_session_id_is_409_and_ends_nothing(string otherId)
    {
        await Client.LoginAsOwnerAsync();

        var response = await Client.Http.PostAsJsonAsync("/api/auth/logout", new { sessionId = otherId });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        await Client.MeAsync();
    }

    [Fact]
    public async Task Logout_without_a_session_is_401()
    {
        await Client.Http.GetAsync("/api/auth/me");

        var response = await Client.Http.PostAsync("/api/auth/logout", null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Ending_another_session_logs_it_out()
    {
        var other = new ApiClient(Api);
        var otherMe = await other.LoginAsOwnerAsync();
        await Client.LoginAsOwnerAsync();

        var response = await Client.Http.DeleteAsync($"/api/auth/sessions/{otherMe.SessionId}");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await other.Http.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Ending_the_own_session_is_400()
    {
        var me = await Client.LoginAsOwnerAsync();

        var response = await Client.Http.DeleteAsync($"/api/auth/sessions/{me.SessionId}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Ending_an_unknown_ended_expired_or_malformed_session_is_404()
    {
        var ended = new ApiClient(Api);
        var endedId = (await ended.LoginAsOwnerAsync()).SessionId;
        await ended.Http.PostAsync("/api/auth/logout", null);
        var expired = new ApiClient(Api);
        var expiredId = (await expired.LoginAsOwnerAsync()).SessionId;
        await Client.LoginAsOwnerAsync();
        // Keep this client's session alive while the other one runs out.
        Api.Clock.Advance(TimeSpan.FromMinutes(29));
        Assert.Equal(HttpStatusCode.OK, (await Client.Http.PostAsync("/api/auth/keepalive", null)).StatusCode);
        Api.Clock.Advance(TimeSpan.FromMinutes(2));

        foreach (var id in new[] { Guid.NewGuid().ToString(), endedId.ToString(), expiredId.ToString(), "not-a-guid" })
        {
            var response = await Client.Http.DeleteAsync($"/api/auth/sessions/{id}");
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }
    }

    [Fact]
    public async Task Ending_a_session_needs_an_xsrf_token()
    {
        var other = new ApiClient(Api);
        var otherMe = await other.LoginAsOwnerAsync();
        await Client.LoginAsOwnerAsync();
        Client.SendXsrf = false;

        var response = await Client.Http.DeleteAsync($"/api/auth/sessions/{otherMe.SessionId}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await other.Http.GetAsync("/api/auth/me")).StatusCode);
    }
}
