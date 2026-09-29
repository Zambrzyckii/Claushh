using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class SessionLifetimeTests(ApiFactory api) : ApiTest(api)
{
    private sealed record Expiry(Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);

    [Fact]
    public async Task Keepalive_moves_the_idle_deadline_and_keeps_the_session_id()
    {
        var me = await Client.LoginAsOwnerAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(20));

        var expiry = await KeepaliveAsync();

        Assert.Equal(me.SessionId, expiry.SessionId);
        Assert.Equal(30 * 60, expiry.ExpiresIn);
        Assert.Equal(12 * 60 * 60 - 20 * 60, expiry.AbsoluteExpiresIn);
        Api.Clock.Advance(TimeSpan.FromMinutes(25));
        Assert.Equal(me.SessionId, (await Client.MeAsync()).SessionId);
    }

    [Fact]
    public async Task Me_does_not_extend_and_the_session_ends_exactly_at_the_idle_deadline()
    {
        await Client.LoginAsOwnerAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(20));
        await Client.MeAsync();
        Api.Clock.Advance(TimeSpan.FromMinutes(10));

        var response = await Client.Http.GetAsync("/api/auth/me");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Absolute_deadline_wins_over_keepalive()
    {
        await Client.LoginAsOwnerAsync();
        var step = TimeSpan.FromMinutes(29);
        var elapsed = TimeSpan.Zero;
        Expiry? last = null;
        while (elapsed + step < TimeSpan.FromHours(12))
        {
            Api.Clock.Advance(step);
            elapsed += step;
            last = await KeepaliveAsync();
        }

        // 24 keepalives: 11 h 36 min, only 24 min left, so the idle deadline is capped by the absolute one.
        Assert.Equal(24 * 60, last!.AbsoluteExpiresIn);
        Assert.Equal(last.AbsoluteExpiresIn, last.ExpiresIn);
        Api.Clock.Advance(TimeSpan.FromHours(12) - elapsed);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.PostAsync("/api/auth/keepalive", null)).StatusCode);
    }

    [Fact]
    public async Task Keepalive_needs_a_session_and_an_xsrf_token()
    {
        await Client.Http.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client.Http.PostAsync("/api/auth/keepalive", null)).StatusCode);

        await Client.LoginAsOwnerAsync();
        Client.SendXsrf = false;
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.PostAsync("/api/auth/keepalive", null)).StatusCode);
    }

    private async Task<Expiry> KeepaliveAsync()
    {
        var response = await Client.Http.PostAsync("/api/auth/keepalive", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<Expiry>())!;
    }
}
