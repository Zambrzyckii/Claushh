// API entry point. Stages and decisions: docs/PLAN.md; endpoints, configuration and commands: docs/ARCHITECTURE.md, "Backend".
using Claushh.Api.Auth;
using Claushh.Api.Data;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.Configure<AuthSessionOptions>(builder.Configuration.GetSection("Sessions"));
builder.Services.AddDbContext<ClaushhDbContext>((services, options) => options.UseNpgsql(
    services.GetRequiredService<IConfiguration>().GetConnectionString("Claushh")
    ?? throw new InvalidOperationException("ConnectionStrings:Claushh is not set (README.md, \"Running in development\").")));
builder.Services
    .AddIdentityCore<IdentityUser>(options =>
    {
        // Length instead of composition rules; TOTP is mandatory anyway (docs/PLAN.md, "Login and sessions").
        options.Password.RequiredLength = 12;
        options.Password.RequireDigit = false;
        options.Password.RequireLowercase = false;
        options.Password.RequireUppercase = false;
        options.Password.RequireNonAlphanumeric = false;
    })
    .AddEntityFrameworkStores<ClaushhDbContext>()
    .AddTokenProvider<AuthenticatorTokenProvider<IdentityUser>>(TokenOptions.DefaultAuthenticatorProvider);

builder.Services.AddSingleton<AuthCookies>();
builder.Services.AddScoped<SessionService>();
builder.Services.AddAuthentication(SessionAuthenticationHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, SessionAuthenticationHandler>(SessionAuthenticationHandler.SchemeName, _ => { });
// Closed by default: an endpoint without .AllowAnonymous() requires a session.
builder.Services.AddAuthorizationBuilder()
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
builder.Services.AddAntiforgery();
builder.Services.AddOptions<AntiforgeryOptions>().Configure<AuthCookies>((options, cookies) =>
{
    options.HeaderName = "X-XSRF-TOKEN";
    options.Cookie.Name = cookies.Antiforgery;
    options.Cookie.Path = "/";
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = cookies.SecureRequired ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
});
builder.Services.AddSingleton<IAntiforgeryAdditionalDataProvider, SessionAntiforgeryData>();
builder.Services.AddProblemDetails();

var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    await scope.ServiceProvider.GetRequiredService<ClaushhDbContext>().Database.MigrateAsync();
}

// First, so that also 401 from authorization and 500 from the error handler get the header.
app.Use((context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.OnStarting(() =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Task.CompletedTask;
        });
    }
    return next(context);
});
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
var api = app.MapGroup("/api").RequireXsrfToken();
api.MapAuthEndpoints();
// Unknown /api paths: 401 without a session (fallback policy), 404 with one, never another handler's response.
api.Map("{**path}", () => Results.NotFound());

app.Run();
