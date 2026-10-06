// API entry point. Stages and decisions: docs/PLAN.md; endpoints, configuration and commands: docs/ARCHITECTURE.md, "Backend".
using Claushh.Api.Auth;
using Claushh.Api.Claude;
using Claushh.Api.Data;
using Claushh.Api.Files;
using Claushh.Api.Frontend;
using Claushh.Api.Git;
using Claushh.Api.Hubs;
using Claushh.Api.Notifications;
using Claushh.Api.Terminal;
using Claushh.Api.Workspaces;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

// The backend runs only on Linux (docs/PLAN.md, "Backend decisions (stage 2)"): libc calls and Unix file modes.
[assembly: System.Runtime.Versioning.SupportedOSPlatform("linux")]

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.Configure<AuthSessionOptions>(builder.Configuration.GetSection("Sessions"));
builder.Services.AddOptions<ProjectsOptions>()
    .Bind(builder.Configuration.GetSection("Projects"))
    .Validate(options => Path.IsPathFullyQualified(options.Root) && Directory.Exists(options.Root)
            && Libc.RealPath(options.Root, out _) is not (null or "/"),
        "Projects:Root must be the absolute path of an existing directory other than / (README.md, \"Running in development\").")
    .Validate(options => Libc.CanReadWriteAndSearch(options.Root),
        "Projects:Root must be a directory the API can read, write and search (README.md, \"Running in development\").")
    .ValidateOnStart();
builder.Services.AddOptions<GitOptions>()
    .Bind(builder.Configuration.GetSection("Git"))
    .Validate(options => options.NetworkTimeout > TimeSpan.Zero, "Git:NetworkTimeout must be a positive time span.")
    .ValidateOnStart();
builder.Services.AddOptions<FrontendOptions>()
    .Bind(builder.Configuration.GetSection("Frontend"))
    .Validate(options => options.Root.Length == 0 || Path.IsPathFullyQualified(options.Root),
        "Frontend:Root must be empty or an absolute path (README.md, \"Running the built frontend\").")
    .Validate(options => !Path.IsPathFullyQualified(options.Root) || FrontendFiles.ReadPolicy(options.Root) is not null,
        "Frontend:Root must hold the frontend build: an index.html with a Content-Security-Policy <meta> (README.md, \"Running the built frontend\").")
    .ValidateOnStart();
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
        // Version 3 adds Identity's passkey table (docs/PLAN.md, "Backend decisions (passkeys)").
        options.Stores.SchemaVersion = IdentitySchemaVersions.Version3;
    })
    .AddEntityFrameworkStores<ClaushhDbContext>();

builder.Services.AddSingleton<AuthCookies>();
builder.Services.AddScoped<SessionService>();
builder.Services.AddScoped<TotpVerifier>();
builder.Services.AddScoped<LoginGuard>();
builder.Services.AddSingleton<PasskeyCeremonies>();
builder.Services.AddOptions<PasskeysOptions>()
    .Bind(builder.Configuration.GetSection("Passkeys"))
    .Validate(options => Uri.CheckHostName(options.ServerDomain) == UriHostNameType.Dns
            && options.ServerDomain == options.ServerDomain.ToLowerInvariant(),
        "Passkeys:ServerDomain must be the portal's lower-case host name, e.g. localhost in development (docs/ARCHITECTURE.md, \"Backend\", configuration).")
    .ValidateOnStart();
// Identity's passkey handler, called directly: AddIdentityCore registers none, and SignInManager would keep the
// ceremonies in Identity's cookies, which the portal does not use (docs/PLAN.md, "Backend decisions (passkeys)").
builder.Services.AddScoped<IPasskeyHandler<IdentityUser>, PasskeyHandler<IdentityUser>>();
builder.Services.AddOptions<IdentityPasskeyOptions>().Configure<IOptions<PasskeysOptions>>((options, passkeys) =>
{
    options.ServerDomain = passkeys.Value.ServerDomain;
    options.UserVerificationRequirement = "required";
    // Login has no user name, so a passkey must be discoverable; the server itself does not check this.
    options.ResidentKeyRequirement = "required";
    // The exact origins the portal is served from, as for the hubs. This replaces Identity's own check, so it refuses a
    // cross-origin or embedded ceremony itself.
    options.ValidateOrigin = context => ValueTask.FromResult(!context.CrossOrigin && context.TopOrigin is null
        && context.HttpContext.RequestServices.GetRequiredService<IOptions<HubsOptions>>().Value.AllowedOrigins
            .Contains(context.Origin, StringComparer.Ordinal));
});
builder.Services.AddSingleton<AuthCleanup>();
builder.Services.AddHostedService(services => services.GetRequiredService<AuthCleanup>());
builder.Services.AddOptions<NotificationsOptions>()
    .Bind(builder.Configuration.GetSection("Notifications"))
    .Validate<IHostEnvironment>((options, environment) => options.NtfyUrl.Length > 0 || !environment.IsProduction(),
        "Notifications:NtfyUrl must be set in Production (docs/PLAN.md, \"Deployment\").")
    .Validate(options => options.NtfyUrl.Length == 0
            || (Uri.TryCreate(options.NtfyUrl, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps),
        "Notifications:NtfyUrl must be an absolute https URL (docs/ARCHITECTURE.md, \"Backend\", configuration).")
    .ValidateOnStart();
// No HttpClient logs: they would write the topic URL, which is a secret.
builder.Services.AddHttpClient(LoginNotifications.ClientName, client => client.Timeout = LoginNotifications.SendTimeout)
    .RemoveAllLoggers();
builder.Services.AddSingleton<LoginNotifications>();
// Sends the queued notifications; create-user never starts the host, so it never runs this.
builder.Services.AddHostedService(services => services.GetRequiredService<LoginNotifications>());
builder.Services.AddScoped<CreateUserCommand>();
builder.Services.AddSingleton<ProjectPaths>();
builder.Services.AddSingleton<FileStore>();
builder.Services.AddSingleton<SearchLimits>();
builder.Services.AddSingleton<FileSearch>();
builder.Services.AddSingleton<Repositories>();
builder.Services.AddScoped<WorkspaceStore>();
builder.Services.AddSingleton<GitRunner>();
builder.Services.AddSingleton<RepoLocks>();
builder.Services.AddSingleton<BackgroundFetch>();
builder.Services.Configure<HubsOptions>(builder.Configuration.GetSection("Hubs"));
builder.Services.AddSingleton<HubConnections>();
builder.Services.AddSingleton<HubSessionFilter>();
builder.Services.AddSingleton<HubSessionSweep>();
builder.Services.AddHostedService(services => services.GetRequiredService<HubSessionSweep>());
// For every hub: the session on connect and on every call (docs/ARCHITECTURE.md, "Backend" → "Hubs").
builder.Services.AddSignalR(options => options.AddFilter<HubSessionFilter>())
    // A console prompt may hold 100,000 characters; every other hub keeps the 32 KB default.
    .AddHubOptions<ConsoleHub>(options => options.MaximumReceiveMessageSize = ConsoleHub.MaxMessage);
builder.Services.Configure<TerminalOptions>(builder.Configuration.GetSection("Terminal"));
builder.Services.AddSingleton<TmuxServer>();
builder.Services.AddSingleton<Terminals>();
// Prepares the tmux server at start and ends it on a stop; create-user never starts the host, so it never runs this.
builder.Services.AddHostedService(services => services.GetRequiredService<Terminals>());
builder.Services.Configure<ConsoleOptions>(builder.Configuration.GetSection("Console"));
builder.Services.AddSingleton<ClaudeCli>();
builder.Services.AddSingleton<ConversationLog>();
builder.Services.AddSingleton<Conversations>();
// Prepares the claude CLI's config directory and ends turns left open at start, closes idle processes, stops them all
// on a stop; create-user never starts the host, so it never runs this.
builder.Services.AddHostedService(services => services.GetRequiredService<Conversations>());
builder.Services.AddSingleton<ConversationCleanup>();
builder.Services.AddHostedService(services => services.GetRequiredService<ConversationCleanup>());
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
    // X-Frame-Options comes from SecurityHeaders as DENY on every response; antiforgery would add SAMEORIGIN.
    options.SuppressXFrameOptionsHeader = true;
});
builder.Services.AddSingleton<IAntiforgeryAdditionalDataProvider, SessionAntiforgeryData>();
builder.Services.AddProblemDetails();

var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    await scope.ServiceProvider.GetRequiredService<ClaushhDbContext>().Database.MigrateAsync();
}

// `dotnet run -- create-user [--reset-totp | --reset-password]`: set up the account and exit without starting the
// HTTP server.
if (args is ["create-user", .. var flags])
{
    if (flags is not ([] or ["--reset-totp"] or ["--reset-password"]))
    {
        Console.WriteLine("Usage: create-user [--reset-totp | --reset-password]");
        return 2;
    }
    await using var scope = app.Services.CreateAsyncScope();
    var command = scope.ServiceProvider.GetRequiredService<CreateUserCommand>();
    return flags is ["--reset-password"]
        ? await command.ResetPasswordAsync(ConsoleTerminal.Instance, CancellationToken.None)
        : await command.RunAsync(flags is ["--reset-totp"], ConsoleTerminal.Instance, CancellationToken.None);
}

// The built frontend (docs/ARCHITECTURE.md, "Backend" → "Frontend"); null when Frontend:Root is empty. Read here, after
// create-user, because the static files and the fallback need it when they are mapped.
var frontend = FrontendFiles.Options(app.Services.GetRequiredService<IOptions<FrontendOptions>>().Value);

// First in every environment: the client's address (CF-Connecting-IP) and scheme (X-Forwarded-Proto) as the local
// cloudflared forwards them. The default lists trust only a loopback peer (docs/ARCHITECTURE.md, "Backend" → "Client
// address"); never ASPNETCORE_FORWARDEDHEADERS_ENABLED, which trusts every proxy.
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    ForwardedForHeaderName = "CF-Connecting-IP",
});

// Before the error handler and authorization, so their 500 and 401 and the Origin check's 403 get the headers too.
app.UseSecurityHeaders();
app.UseExceptionHandler();
// Before routing and the files of the build (docs/ARCHITECTURE.md, "Backend" → "Frontend").
app.UseDoubleSlashNotFound();
// Explicit, so that endpoint matching runs before the static files: a request that matched /api, /hubs or the fallback
// is never answered with a file.
app.UseRouting();
app.UseFrontendFiles(frontend);
// Before authentication: a foreign or missing Origin never reaches the session lookup.
app.UseHubOriginCheck();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
var api = app.MapGroup("/api").RequireXsrfToken();
api.MapAuthEndpoints().MapSessionEndpoints().MapPasskeyEndpoints().MapFileEndpoints().MapSearchEndpoints().MapWorkspaceEndpoints().MapGitEndpoints().MapTerminalEndpoints();
// Unknown /api paths: 401 without a session (fallback policy), 404 with one, never another handler's response.
api.Map("{**path}", () => Results.NotFound());
// WebSocket only: the frontend skips negotiation, and other transports would only add ways in.
app.MapHub<TerminalHub>("/hubs/terminal", options => options.Transports = HttpTransportType.WebSockets)
    .RequireAuthorization();
// A hub message is parsed only once it is whole, so the connection's buffers hold a whole 1 MiB message.
app.MapHub<ConsoleHub>("/hubs/console", options =>
    {
        options.Transports = HttpTransportType.WebSockets;
        options.ApplicationMaxBufferSize = ConsoleHub.MaxMessage;
        options.TransportMaxBufferSize = ConsoleHub.MaxMessage;
    })
    .RequireAuthorization();
// Unknown /hubs paths: 401 without a session, 404 with one, never the page. The MapHub routes are more specific.
app.Map("/hubs/{**path}", () => Results.NotFound());
app.MapFrontendFallback(frontend);

// Production: once the host has started, other processes of the API's user can neither read its /proc files (its
// environment holds the secrets) nor attach to it (docs/PLAN.md, "Limiting damage"). After the start, so a test host
// that runs Program in Production only to see it refuse is never changed. When that fails, the API logs errno and ends
// with exit status 71 (EX_OSERR), which the unit does not restart (deploy/claushh.service, RestartPreventExitStatus=).
const int NotDumpableFailed = 71;
var exitCode = 0;
if (app.Environment.IsProduction())
{
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        if (!Libc.MakeNotDumpable(out var errno))
        {
            app.Logger.LogCritical("Making the process non-dumpable failed with errno {Errno}; stopping.", errno);
            exitCode = NotDumpableFailed;
            app.Lifetime.StopApplication();
        }
    });
}

app.Run();
return exitCode;
