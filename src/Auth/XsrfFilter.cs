// The XSRF protection of every state-changing /api request (docs/ARCHITECTURE.md, "Backend"): antiforgery with the
// portal's cookie and header names, the token bound to the session (SessionAntiforgeryData), and the filter on the /api
// group.
using Microsoft.AspNetCore.Antiforgery;

namespace Claushh.Api.Auth;

public static class XsrfFilter
{
    public static IServiceCollection AddXsrfProtection(this IServiceCollection services)
    {
        services.AddAntiforgery();
        services.AddOptions<AntiforgeryOptions>().Configure<AuthCookies>((options, cookies) =>
        {
            options.HeaderName = "X-XSRF-TOKEN";
            options.Cookie.Name = cookies.Antiforgery;
            options.Cookie.Path = "/";
            options.Cookie.SameSite = SameSiteMode.Strict;
            options.Cookie.SecurePolicy = cookies.SecureRequired ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
            // X-Frame-Options comes from SecurityHeaders as DENY on every response; antiforgery would add SAMEORIGIN.
            options.SuppressXFrameOptionsHeader = true;
        });
        services.AddSingleton<IAntiforgeryAdditionalDataProvider, SessionAntiforgeryData>();
        return services;
    }

    // Every state-changing request needs a valid XSRF token (GET, HEAD, OPTIONS and TRACE pass through).
    // Runs after authentication, because the token is bound to the identity.
    public static RouteGroupBuilder RequireXsrfToken(this RouteGroupBuilder api)
    {
        api.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var antiforgery = http.RequestServices.GetRequiredService<IAntiforgery>();
            return await antiforgery.IsRequestValidAsync(http) ? await next(context) : Results.BadRequest();
        });
        return api;
    }
}
