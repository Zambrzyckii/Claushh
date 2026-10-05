using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Claushh.Api.Auth;
using Claushh.Api.Hubs;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

public sealed class HubConnectionTests(ApiFactory api) : ApiTest(api)
{
    private static readonly TimeSpan CloseWait = TimeSpan.FromSeconds(5);
    // The sweep inside the request closes the connection before the response; HubSessionSweep's 5 s timer alone takes up
    // to 5 s, so a close within 1 s comes from the request.
    private static readonly TimeSpan InRequestWait = TimeSpan.FromSeconds(1);
    // The timer's period, 5 s, with room to spare.
    private static readonly TimeSpan TimerWait = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task A_hub_without_a_session_is_401()
    {
        var response = await SendHubAsync(HttpMethod.Get, "/hubs/terminal");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("https://evil.example")]
    [InlineData("https://localhost:4200")]
    [InlineData("HTTPS://LOCALHOST")]
    public async Task A_missing_empty_or_foreign_origin_is_403_with_an_empty_body(string? origin)
    {
        await Client.LoginAsOwnerAsync();

        var response = await SendHubAsync(HttpMethod.Get, "/hubs/terminal", origin);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task A_foreign_origin_without_a_session_is_403_not_401()
    {
        // The Origin check runs before authentication, so a request with neither still fails on the origin first.
        var response = await SendHubAsync(HttpMethod.Get, "/hubs/terminal", "https://evil.example");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task A_session_and_an_allowed_origin_connect_over_a_websocket()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);

        Assert.Empty(await hub.InvokeAsync<JsonElement[]>("ListTerminals"));
    }

    [Fact]
    public async Task A_websocket_without_origin_is_refused()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = TestHub.Build(Api, Client, origin: null);

        var error = await Assert.ThrowsAnyAsync<Exception>(() => hub.StartAsync());

        Assert.Contains("403", error.ToString());
    }

    [Fact]
    public async Task Only_websockets_are_offered_and_long_polling_is_404()
    {
        await Client.LoginAsOwnerAsync();

        var negotiate = await SendHubAsync(HttpMethod.Post, "/hubs/terminal/negotiate?negotiateVersion=1");
        Assert.Equal(HttpStatusCode.OK, negotiate.StatusCode);
        var body = await negotiate.Content.ReadFromJsonAsync<JsonElement>();
        var transports = body.GetProperty("availableTransports").EnumerateArray()
            .Select(transport => transport.GetProperty("transport").GetString()).ToArray();
        // A poll on a connection the negotiation created: refused because long polling is not enabled.
        var poll = await SendHubAsync(HttpMethod.Get, $"/hubs/terminal?id={body.GetProperty("connectionToken").GetString()}");

        Assert.DoesNotContain("LongPolling", transports);
        Assert.DoesNotContain("ServerSentEvents", transports);
        Assert.Equal(HttpStatusCode.NotFound, poll.StatusCode);
    }

    [Fact]
    public async Task Logout_closes_the_connections_of_the_session()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        var closed = TestHub.WhenClosed(hub);

        Assert.Equal(HttpStatusCode.NoContent, (await Client.Http.PostAsync("/api/auth/logout", null)).StatusCode);

        await closed.WaitAsync(InRequestWait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Ending_a_session_from_another_one_closes_its_connections()
    {
        var laptop = new ApiClient(Api);
        var laptopSession = await laptop.LoginAsOwnerAsync();
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, laptop);
        var closed = TestHub.WhenClosed(hub);

        var response = await Client.Http.DeleteAsync($"/api/auth/sessions/{laptopSession.SessionId}");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        await closed.WaitAsync(InRequestWait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Revoking_the_other_sessions_closes_theirs_and_keeps_the_current_one()
    {
        var laptop = new ApiClient(Api);
        await laptop.LoginAsOwnerAsync();
        await Client.LoginAsOwnerAsync();
        await using var other = await TestHub.ConnectAsync(Api, laptop);
        await using var current = await TestHub.ConnectAsync(Api, Client);
        var otherClosed = TestHub.WhenClosed(other);

        var response = await Client.Http.PostAsync("/api/auth/sessions/revoke-others", null);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        await otherClosed.WaitAsync(InRequestWait, TestContext.Current.CancellationToken);
        Assert.Empty(await current.InvokeAsync<JsonElement[]>("ListTerminals"));
        Assert.Equal(HubConnectionState.Connected, current.State);
    }

    [Fact]
    public async Task A_call_after_the_session_expired_fails_and_closes_the_connection()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        var closed = TestHub.WhenClosed(hub);
        // Past the idle deadline (Sessions:IdleTimeout, 30 minutes), with no sweep run by the test.
        Api.Clock.Advance(TimeSpan.FromMinutes(31));

        // caller.Abort() in InvokeMethodAsync (HubSessionFilter.cs) runs before the HubException is written back, so
        // the client observes a cancelled call rather than "Sesja wygasła": any exception, not a particular type.
        await Assert.ThrowsAnyAsync<Exception>(() => hub.InvokeAsync<JsonElement[]>("ListTerminals"));

        await closed.WaitAsync(CloseWait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task A_call_right_after_a_revocation_in_another_process_fails_and_closes_the_connection()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        var closed = TestHub.WhenClosed(hub);

        // As create-user --reset-totp does in its own process: only the database changes, before any sweep runs.
        await using (var scope = Api.Services.CreateAsyncScope())
        {
            var owner = await scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser>>().FindByNameAsync(ApiFactory.UserName);
            await scope.ServiceProvider.GetRequiredService<SessionService>().RevokeAllAsync(owner!.Id, TestContext.Current.CancellationToken);
        }

        // Same as above: the client sees the connection close, not the "Sesja wygasła" text.
        await Assert.ThrowsAnyAsync<Exception>(() => hub.InvokeAsync<JsonElement[]>("ListTerminals"));

        await closed.WaitAsync(CloseWait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task A_connection_that_fails_during_OnConnectedAsync_is_not_leaked_in_the_registry()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = TestHub.Build(Api, Client, $"/hubs/terminal?{TestHubThrow.QueryParam}=1");
        var closed = TestHub.WhenClosed(hub);

        // The handshake (StartAsync) succeeds: SignalR runs OnConnectedAsync only after it. The server then closes the
        // connection without ever calling OnDisconnectedAsync, which is exactly the leak this test pins.
        await hub.StartAsync();
        await closed.WaitAsync(CloseWait, TestContext.Current.CancellationToken);

        Assert.Empty(Api.Services.GetRequiredService<HubConnections>().Sessions());
        await Api.Services.GetRequiredService<HubSessionSweep>().RunOnceAsync(TestContext.Current.CancellationToken);
        Assert.Empty(Api.Services.GetRequiredService<HubConnections>().Sessions());
    }

    [Fact]
    public async Task Hub_calls_never_extend_the_session()
    {
        var before = await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        Api.Clock.Advance(TimeSpan.FromMinutes(1));

        await hub.InvokeAsync<JsonElement[]>("ListTerminals");

        Assert.Equal(before.ExpiresIn - 60, (await Client.MeAsync()).ExpiresIn);
    }

    [Fact]
    public async Task Connections_of_an_expired_session_close_at_the_next_sweep()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        var closed = TestHub.WhenClosed(hub);

        Api.Clock.Advance(TimeSpan.FromMinutes(31));
        await Api.Services.GetRequiredService<HubSessionSweep>().RunOnceAsync(TestContext.Current.CancellationToken);

        await closed.WaitAsync(CloseWait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Sessions_ended_in_another_process_close_at_the_next_sweep()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        var closed = TestHub.WhenClosed(hub);

        // As create-user --reset-totp does in its own process: only the database changes.
        await using (var scope = Api.Services.CreateAsyncScope())
        {
            var owner = await scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser>>().FindByNameAsync(ApiFactory.UserName);
            await scope.ServiceProvider.GetRequiredService<SessionService>().RevokeAllAsync(owner!.Id, TestContext.Current.CancellationToken);
        }
        await Api.Services.GetRequiredService<HubSessionSweep>().RunOnceAsync(TestContext.Current.CancellationToken);

        await closed.WaitAsync(CloseWait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task The_timer_closes_the_connections_of_an_expired_session_by_itself()
    {
        await Client.LoginAsOwnerAsync();
        await using var hub = await TestHub.ConnectAsync(Api, Client);
        var closed = TestHub.WhenClosed(hub);

        // Past the idle deadline, with no call and no RunOnceAsync: only HubSessionSweep's timer can close it.
        Api.Clock.Advance(TimeSpan.FromMinutes(31));

        await closed.WaitAsync(TimerWait, TestContext.Current.CancellationToken);
    }

    private Task<HttpResponseMessage> SendHubAsync(HttpMethod method, string url, string? origin = TestHub.Origin)
    {
        var request = new HttpRequestMessage(method, url);
        if (origin is not null)
        {
            request.Headers.TryAddWithoutValidation("Origin", origin);
        }
        return Client.Http.SendAsync(request);
    }
}
