// HTTP client that behaves like the browser with Angular: keeps cookies, sends XSRF-TOKEN back in X-XSRF-TOKEN, and
// comes from the IP in Ip (TestRemoteIp).
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
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

    // POST /api/auth/reauthenticate, as the Security dialog asks before adding or removing a passkey.
    public Task<HttpResponseMessage> ReauthenticateAsync(string password, string totpCode) =>
        Http.PostAsJsonAsync("/api/auth/reauthenticate", new { password, totpCode });

    // Creation options for a new passkey; the session must have re-authenticated.
    public async Task<JsonElement> CreationOptionsAsync()
    {
        var response = await Http.PostAsync("/api/auth/passkeys/creation-options", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    // Re-authentication (with the next code), creation options and the authenticator's credential.
    public async Task<JsonObject> PreparePasskeyAsync(TestAuthenticator authenticator)
    {
        Assert.Equal(HttpStatusCode.NoContent, (await ReauthenticateAsync(ApiFactory.Password, _api.NextTotp())).StatusCode);
        return authenticator.Register(await CreationOptionsAsync());
    }

    // Adds a passkey the way the Security dialog does.
    public async Task<HttpResponseMessage> AddPasskeyAsync(TestAuthenticator authenticator, string? name = "Laptop") =>
        await PostPasskeyAsync(await PreparePasskeyAsync(authenticator), name);

    public Task<HttpResponseMessage> PostPasskeyAsync(JsonObject credential, string? name = "Laptop") =>
        Http.PostAsJsonAsync("/api/auth/passkeys", new { credential, name });

    // Like the login button: GET /me for an XSRF token, then the request options and the challenge cookie.
    public async Task<HttpResponseMessage> LoginOptionsAsync()
    {
        await Http.GetAsync("/api/auth/me");
        return await Http.PostAsync("/api/auth/passkeys/login-options", null);
    }

    // The whole passkey login of the frontend: options, the authenticator's assertion, the login.
    public async Task<HttpResponseMessage> PasskeyLoginAsync(TestAuthenticator authenticator)
    {
        var options = await LoginOptionsAsync();
        Assert.Equal(HttpStatusCode.OK, options.StatusCode);
        return await Http.PostAsJsonAsync("/api/auth/passkeys/login",
            new { credential = authenticator.Assert(await options.Content.ReadFromJsonAsync<JsonElement>()) });
    }

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
