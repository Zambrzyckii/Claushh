// HTTP client that behaves like the browser with Angular: keeps cookies, sends XSRF-TOKEN back in X-XSRF-TOKEN, and
// comes from the IP in Ip (TestRemoteIp).
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing.Handlers;

namespace Claushh.Api.Tests;

public sealed class ApiClient
{
    // https, so the Secure cookies are sent back.
    public static readonly Uri BaseAddress = new("https://localhost");
    public const string SessionCookie = "__Host-claushh-session";

    private readonly ApiFactory _api;

    public ApiClient(ApiFactory api)
    {
        _api = api;
        Http = api.CreateDefaultClient(BaseAddress, new BrowserHandler(this), new CookieContainerHandler(Cookies));
    }

    public HttpClient Http { get; }
    public CookieContainer Cookies { get; } = new();
    public bool SendXsrf { get; set; } = true;
    public string Ip { get; set; } = "127.0.0.1";

    public string? Cookie(string name) => Cookies.GetCookies(BaseAddress)[name]?.Value;

    // Like AuthService.login: GET /me first for a fresh XSRF token, then POST /login.
    public async Task<HttpResponseMessage> LoginAsync(string userName, string password, string totpCode)
    {
        await Http.GetAsync("/api/auth/me");
        return await Http.PostAsJsonAsync("/api/auth/login", new { userName, password, totpCode });
    }

    // Logs in as the seeded owner and, like the frontend, takes the XSRF token bound to the new session.
    public async Task<MeBody> LoginAsOwnerAsync()
    {
        var login = await LoginAsync(ApiFactory.UserName, ApiFactory.Password, _api.NextTotp());
        Assert.Equal(HttpStatusCode.NoContent, login.StatusCode);
        return await MeAsync();
    }

    public async Task<MeBody> MeAsync()
    {
        var response = await Http.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<MeBody>())!;
    }

    public static string SetCookie(HttpResponseMessage response, string name) =>
        response.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith(name + "=", StringComparison.Ordinal)).ToLowerInvariant();

    public sealed record MeBody(string UserName, Guid SessionId, int ExpiresIn, int AbsoluteExpiresIn);

    private sealed class BrowserHandler(ApiClient client) : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            request.Headers.Add(TestRemoteIp.Header, client.Ip);
            if (client.SendXsrf && request.Method != HttpMethod.Get && client.Cookie("XSRF-TOKEN") is { } token)
            {
                request.Headers.Add("X-XSRF-TOKEN", token);
            }
            return base.SendAsync(request, ct);
        }
    }
}
