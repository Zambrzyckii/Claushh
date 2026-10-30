// What auth adds to the host (Program.cs calls it in a fixed order, docs/ARCHITECTURE.md, "Repository map").
using Claushh.Api.Auth.Account;
using Claushh.Api.Auth.Notifications;
using Claushh.Api.Auth.Passkeys;
using Claushh.Api.Auth.Realtime;
using Claushh.Api.Data;
using Claushh.Api.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Auth;

public static class AuthModule
{
    public static IServiceCollection AddAuth(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<AuthSessionOptions>(configuration.GetSection("Sessions"));
        services
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

        services.AddSingleton<AuthCookies>();
        services.AddScoped<SessionService>();
        services.AddScoped<TotpVerifier>();
        services.AddScoped<LoginGuard>();
        services.AddScoped<SignIn>();
        services.AddSingleton<PasskeyCeremonies>();
        services.AddOptions<PasskeysOptions>()
            .Bind(configuration.GetSection("Passkeys"))
            .Validate(options => Uri.CheckHostName(options.ServerDomain) == UriHostNameType.Dns
                    && options.ServerDomain == options.ServerDomain.ToLowerInvariant(),
                "Passkeys:ServerDomain must be the portal's lower-case host name, e.g. localhost in development (docs/ARCHITECTURE.md, \"Backend\", configuration).")
            .ValidateOnStart();
        // Identity's passkey handler, called directly: AddIdentityCore registers none, and SignInManager would keep the
        // ceremonies in Identity's cookies, which the portal does not use (docs/PLAN.md, "Backend decisions (passkeys)").
        services.AddScoped<IPasskeyHandler<IdentityUser>, PasskeyHandler<IdentityUser>>();
        services.AddOptions<IdentityPasskeyOptions>().Configure<IOptions<PasskeysOptions>>((options, passkeys) =>
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
        services.AddSingleton<AuthCleanup>();
        services.AddHostedService(services => services.GetRequiredService<AuthCleanup>());
        services.AddOptions<NotificationsOptions>()
            .Bind(configuration.GetSection("Notifications"))
            .Validate<IHostEnvironment>((options, environment) => options.NtfyUrl.Length > 0 || !environment.IsProduction(),
                "Notifications:NtfyUrl must be set in Production (docs/PLAN.md, \"Deployment\").")
            .Validate(options => options.NtfyUrl.Length == 0
                    || (Uri.TryCreate(options.NtfyUrl, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps),
                "Notifications:NtfyUrl must be an absolute https URL (docs/ARCHITECTURE.md, \"Backend\", configuration).")
            .ValidateOnStart();
        // No HttpClient logs: they would write the topic URL, which is a secret.
        services.AddHttpClient(LoginNotifications.ClientName, client => client.Timeout = LoginNotifications.SendTimeout)
            .RemoveAllLoggers();
        services.AddSingleton<LoginNotifications>();
        // Sends the queued notifications; create-user never starts the host, so it never runs this.
        services.AddHostedService(services => services.GetRequiredService<LoginNotifications>());
        services.AddScoped<CreateUserCommand>();
        services.AddSingleton<HubConnections>();
        services.AddSingleton<HubSessionFilter>();
        services.AddSingleton<HubSessionSweep>();
        services.AddHostedService(services => services.GetRequiredService<HubSessionSweep>());
        return services;
    }

    public static IServiceCollection AddSessionAuthentication(this IServiceCollection services)
    {
        services.AddAuthentication(SessionAuthenticationHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SessionAuthenticationHandler>(SessionAuthenticationHandler.SchemeName, _ => { });
        // Closed by default: an endpoint without .AllowAnonymous() requires a session.
        services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
        return services;
    }
}
