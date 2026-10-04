using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

// The client's address and scheme behind Cloudflare Tunnel: CF-Connecting-IP and X-Forwarded-Proto count only from a
// loopback peer, the local cloudflared (docs/ARCHITECTURE.md, "Backend" → "Client address"). The peer comes from
// TestRemoteIp (ApiClient.Ip).
public sealed class ClientAddressTests(ApiFactory api) : ApiTest(api)
{
    private static readonly Uri PlainHttp = new("http://localhost");

    private sealed record AttemptBody(DateTimeOffset At, string Ip, string Device, bool Success);
    private sealed record SessionBody(Guid Id, bool Current, string Device, string Ip, DateTimeOffset CreatedAt, DateTimeOffset LastActivityAt);

    [Fact]
    public async Task Cf_connecting_ip_from_a_loopback_peer_is_the_client_address()
    {
        SetHeader(Client, "CF-Connecting-IP", "203.0.113.9");

        await Client.LoginAsOwnerAsync();

        Assert.Equal("203.0.113.9", Assert.Single(await LoginIpsAsync(Client)));
        Assert.Equal("203.0.113.9", Assert.Single(await SessionIpsAsync(Client)));
    }

    [Fact]
    public async Task A_loopback_peer_without_the_header_keeps_its_own_address()
    {
        await Client.LoginAsOwnerAsync();

        Assert.Equal("127.0.0.1", Assert.Single(await LoginIpsAsync(Client)));
        Assert.Equal("127.0.0.1", Assert.Single(await SessionIpsAsync(Client)));
    }

    [Fact]
    public async Task Clients_behind_the_tunnel_have_their_own_limits()
    {
        var first = new ApiClient(Api);
        SetHeader(first, "CF-Connecting-IP", "203.0.113.1");
        var second = new ApiClient(Api);
        SetHeader(second, "CF-Connecting-IP", "203.0.113.2");
        await FailAsync(first, 10);

        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await first.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await second.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
    }

    [Fact]
    public async Task Cf_connecting_ip_from_another_peer_is_ignored()
    {
        var direct = new ApiClient(Api) { Ip = "198.51.100.7" };
        SetHeader(direct, "CF-Connecting-IP", "203.0.113.9");

        await direct.LoginAsOwnerAsync();

        Assert.Equal("198.51.100.7", Assert.Single(await LoginIpsAsync(direct)));
    }

    [Fact]
    public async Task A_peer_that_is_not_loopback_cannot_change_its_bucket_with_cf_connecting_ip()
    {
        var direct = new ApiClient(Api) { Ip = "198.51.100.7" };
        for (var i = 1; i <= 10; i++)
        {
            SetHeader(direct, "CF-Connecting-IP", $"203.0.113.{i}");
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await direct.LoginAsync(ApiFactory.UserName, "wrong password", "000000")).StatusCode);
        }
        SetHeader(direct, "CF-Connecting-IP", "203.0.113.99");

        var response = await direct.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp());

        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
    }

    [Fact]
    public async Task X_forwarded_for_is_ignored_in_the_history_and_the_limit()
    {
        for (var i = 1; i <= 10; i++)
        {
            SetHeader(Client, "X-Forwarded-For", $"203.0.113.{i}");
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await Client.LoginAsync(ApiFactory.UserName, "wrong password", "000000")).StatusCode);
        }
        SetHeader(Client, "X-Forwarded-For", "203.0.113.99");
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await Client.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        var owner = new ApiClient(Api) { Ip = "198.51.100.20" };

        await owner.LoginAsOwnerAsync();

        Assert.Equal(new[] { "198.51.100.20" }.Concat(Enumerable.Repeat("127.0.0.1", 10)), await LoginIpsAsync(owner));
    }

    [Fact]
    public async Task Plain_http_without_x_forwarded_proto_fails_in_antiforgery()
    {
        var response = await PlainAsync(new HttpRequestMessage(HttpMethod.Get, "/api/auth/me"), "127.0.0.1", proto: null);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
    }

    [Fact]
    public async Task X_forwarded_proto_https_from_a_loopback_peer_gives_the_secure_cookies_and_a_login()
    {
        var me = await PlainAsync(new HttpRequestMessage(HttpMethod.Get, "/api/auth/me"), "127.0.0.1", "https");
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
        Assert.Contains("; secure", ApiClient.SetCookie(me, "__Host-claushh-af"), StringComparison.Ordinal);
        // The cookies back by hand, as a browser on the https address sends them.
        var antiforgery = CookiePair(me, "__Host-claushh-af");
        var xsrf = CookiePair(me, "XSRF-TOKEN");
        var login = new HttpRequestMessage(HttpMethod.Post, "/api/auth/login")
        {
            Content = JsonContent.Create(new { userName = ApiFactory.UserName, password = ApiFactory.Password, totpCode = Api.NextTotp() }),
        };
        login.Headers.TryAddWithoutValidation("Cookie", $"{antiforgery}; {xsrf}");
        login.Headers.TryAddWithoutValidation("X-XSRF-TOKEN", xsrf["XSRF-TOKEN=".Length..]);

        var response = await PlainAsync(login, "127.0.0.1", "https");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains("; secure", ApiClient.SetCookie(response, ApiClient.SessionCookie), StringComparison.Ordinal);
    }

    [Fact]
    public async Task X_forwarded_proto_from_another_peer_is_ignored()
    {
        var response = await PlainAsync(new HttpRequestMessage(HttpMethod.Get, "/api/auth/me"), "198.51.100.7", "https");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
    }

    // Pinned framework behaviour: TestServer has no peer address unless TestRemoteIp sets one, and ForwardedHeaders allows a
    // missing address for servers that have none, so the header applies. Kestrel over TCP always has a peer; on a Unix
    // socket the header would be trusted as from loopback.
    [Fact]
    public async Task Without_a_peer_address_cf_connecting_ip_is_applied()
    {
        var unknown = new ApiClient(Api) { Ip = "" };
        SetHeader(unknown, "CF-Connecting-IP", "203.0.113.9");

        await unknown.LoginAsOwnerAsync();

        Assert.Equal("203.0.113.9", Assert.Single(await LoginIpsAsync(unknown)));
    }

    [Fact]
    public async Task Ipv6_failures_count_for_the_whole_64_and_the_history_keeps_each_address()
    {
        await FailAsync(new ApiClient(Api) { Ip = "2001:db8:1:2::5" }, 10);
        var neighbour = new ApiClient(Api) { Ip = "2001:db8:1:2::6" };
        var otherNetwork = new ApiClient(Api) { Ip = "2001:db8:1:3::5" };

        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await neighbour.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        await otherNetwork.LoginAsOwnerAsync();

        Assert.Equal(new[] { "2001:db8:1:3::5" }.Concat(Enumerable.Repeat("2001:db8:1:2::5", 10)),
            await LoginIpsAsync(otherNetwork));
    }

    [Fact]
    public async Task An_ipv4_mapped_peer_shares_the_ipv4_bucket_and_shows_as_ipv4()
    {
        var mapped = new ApiClient(Api) { Ip = "::ffff:198.51.100.7" };
        await FailAsync(mapped, 5);
        await FailAsync(new ApiClient(Api) { Ip = "198.51.100.7" }, 5);

        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await mapped.LoginAsync(ApiFactory.UserName, ApiFactory.Password, Api.NextTotp())).StatusCode);
        var owner = new ApiClient(Api) { Ip = "198.51.100.20" };
        await owner.LoginAsOwnerAsync();

        Assert.Equal(new[] { "198.51.100.20" }.Concat(Enumerable.Repeat("198.51.100.7", 10)), await LoginIpsAsync(owner));
    }

    // A request to http://localhost from peer, as cloudflared sends it on the server.
    private async Task<HttpResponseMessage> PlainAsync(HttpRequestMessage request, string peer, string? proto)
    {
        request.Headers.TryAddWithoutValidation(TestRemoteIp.Header, peer);
        if (proto is not null)
        {
            request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", proto);
        }
        return await Api.CreateDefaultClient(PlainHttp).SendAsync(request);
    }

    // "name=value" of a cookie the response sets, unchanged (ApiClient.SetCookie lower-cases it).
    private static string CookiePair(HttpResponseMessage response, string name) =>
        response.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith(name + "=", StringComparison.Ordinal)).Split(';')[0];

    private static void SetHeader(ApiClient client, string name, string value)
    {
        client.Http.DefaultRequestHeaders.Remove(name);
        client.Http.DefaultRequestHeaders.TryAddWithoutValidation(name, value);
    }

    private static async Task<string[]> LoginIpsAsync(ApiClient client) =>
        (await client.Http.GetFromJsonAsync<AttemptBody[]>("/api/auth/logins"))!.Select(a => a.Ip).ToArray();

    private static async Task<string[]> SessionIpsAsync(ApiClient client) =>
        (await client.Http.GetFromJsonAsync<SessionBody[]>("/api/auth/sessions"))!.Select(s => s.Ip).ToArray();

    // Wrong passwords: they count for the per-IP limit, never for the account lockout.
    private static async Task FailAsync(ApiClient client, int times)
    {
        for (var i = 0; i < times; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await client.LoginAsync(ApiFactory.UserName, "wrong password", "000000")).StatusCode);
        }
    }
}
