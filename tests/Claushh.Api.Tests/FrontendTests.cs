using System.Net;
using Microsoft.AspNetCore.Hosting;

namespace Claushh.Api.Tests;

// The built frontend that ApiFactory stands in for (Frontend:Root) and the headers of every response
// (docs/ARCHITECTURE.md, "Security headers" and "Backend" → "Frontend").
public sealed class FrontendTests(ApiFactory api) : ApiTest(api)
{
    private const string Permissions = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

    [Theory]
    [InlineData("/")]
    [InlineData("/login?returnUrl=%2F")]
    [InlineData("/a/b/c")]
    [InlineData("/index.html")]
    public async Task App_paths_get_the_page_with_its_policy_and_no_store(string url)
    {
        var response = await Client.Http.GetAsync(url);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(ApiFactory.FrontendIndex, await response.Content.ReadAsStringAsync());
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Equal(ApiFactory.FrontendPolicy + "; frame-ancestors 'none'", Header(response, "Content-Security-Policy"));
        Assert.Equal("DENY", Header(response, "X-Frame-Options"));
    }

    [Theory]
    [InlineData("/main-TEST.js", "text/javascript")]
    [InlineData("/worker-TEST.js", "text/javascript")]
    [InlineData("/monaco.css", "text/css")]
    [InlineData("/media/codicon-TEST.ttf", "font/ttf")]
    [InlineData("/favicon.ico", "image/x-icon")]
    public async Task Files_of_the_build_have_their_type_and_no_cache_and_no_policy(string url, string type)
    {
        var response = await Client.Http.GetAsync(url);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(type, response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(url.TrimStart('/'), await response.Content.ReadAsStringAsync());
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
        Assert.Null(Header(response, "Content-Security-Policy"));
    }

    [Fact]
    public async Task A_missing_file_is_never_the_page()
    {
        var anonymous = await Client.Http.GetAsync("/chunk-x.js");
        await Client.LoginAsOwnerAsync();
        var withSession = await Client.Http.GetAsync("/chunk-x.js");

        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, withSession.StatusCode);
    }

    // /api itself relies on the catch-all matching an empty rest; api/decoy.js is a real file of the build.
    [Theory]
    [InlineData("/api")]
    [InlineData("/api/nope")]
    [InlineData("/api/decoy.js")]
    public async Task Api_paths_are_never_the_page_or_a_file(string url)
    {
        var anonymous = await Client.Http.GetAsync(url);
        await Client.LoginAsOwnerAsync();
        var withSession = await Client.Http.GetAsync(url);

        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, withSession.StatusCode);
    }

    [Theory]
    [InlineData("/hubs")]
    [InlineData("/hubs/console")]
    [InlineData("/hubs/decoy.js")]
    public async Task Hub_paths_are_never_the_page_or_a_file(string url)
    {
        var noOrigin = await SendAsync(url, origin: null);
        var anonymous = await SendAsync(url, TestHub.Origin);
        await Client.LoginAsOwnerAsync();
        var withSession = await SendAsync(url, TestHub.Origin);

        Assert.Equal(HttpStatusCode.Forbidden, noOrigin.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, withSession.StatusCode);
    }

    [Fact]
    public async Task Every_response_has_the_security_headers()
    {
        using var plainHttp = Api.CreateDefaultClient(new Uri("http://localhost"));
        var responses = new[]
        {
            await Client.Http.GetAsync("/"),
            await Client.Http.GetAsync("/main-TEST.js"),
            await Client.Http.GetAsync("/api/health"),
            // 401; antiforgery would add its own X-Frame-Options: SAMEORIGIN here.
            await Client.Http.GetAsync("/api/auth/me"),
            await SendAsync("/hubs/terminal", origin: null),
            await Client.Http.GetAsync("/chunk-x.js"),
            // Antiforgery refuses plain http while the cookies must be Secure: the error handler's 500.
            await plainHttp.GetAsync("/api/auth/me"),
        };

        Assert.Equal(new[]
        {
            HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden,
            HttpStatusCode.Unauthorized, HttpStatusCode.InternalServerError,
        }, responses.Select(r => r.StatusCode));
        foreach (var response in responses)
        {
            Assert.Equal("DENY", Header(response, "X-Frame-Options"));
            Assert.Equal("nosniff", Header(response, "X-Content-Type-Options"));
            Assert.Equal("no-referrer", Header(response, "Referrer-Policy"));
            Assert.Equal("same-origin", Header(response, "Cross-Origin-Opener-Policy"));
            Assert.Equal("same-origin", Header(response, "Cross-Origin-Resource-Policy"));
            Assert.Equal(Permissions, Header(response, "Permissions-Policy"));
        }
        Assert.True(responses[^1].Headers.CacheControl?.NoStore, "the 500 of an /api path without no-store");
    }

    [Fact]
    public void The_api_refuses_to_start_with_a_relative_frontend_root() =>
        AssertRefusesToStart("web/dist/web/browser", "absolute path");

    [Fact]
    public void The_api_refuses_to_start_when_the_frontend_root_has_no_index_html()
    {
        using var build = new OutsideDirectory();

        AssertRefusesToStart(build.Root, "index.html with a Content-Security-Policy");
    }

    [Fact]
    public void The_api_refuses_to_start_when_index_html_has_no_policy()
    {
        using var build = new OutsideDirectory();
        File.WriteAllText(build.Child("index.html"), "<!doctype html><title>Workspace</title>");

        AssertRefusesToStart(build.Root, "index.html with a Content-Security-Policy");
    }

    // The error has to name the key and say which check failed.
    private void AssertRefusesToStart(string root, string reason)
    {
        using var broken = Api.WithWebHostBuilder(builder => builder.UseSetting("Frontend:Root", root));

        var error = Assert.ThrowsAny<Exception>(() => broken.CreateClient()).ToString();

        Assert.Contains("Frontend:Root", error, StringComparison.Ordinal);
        Assert.Contains(reason, error, StringComparison.Ordinal);
    }

    private Task<HttpResponseMessage> SendAsync(string url, string? origin)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (origin is not null)
        {
            request.Headers.TryAddWithoutValidation("Origin", origin);
        }
        return Client.Http.SendAsync(request);
    }

    // The one value of a response header, or null without it (a second X-Frame-Options fails here).
    private static string? Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) ? Assert.Single(values) : null;
}
