// Session lifetimes and cookie security from the "Sessions" configuration section (docs/ARCHITECTURE.md, "Backend").
namespace Claushh.Api.Auth;

public sealed class AuthSessionOptions
{
    public TimeSpan IdleTimeout { get; set; } = TimeSpan.FromMinutes(30);
    public TimeSpan AbsoluteTimeout { get; set; } = TimeSpan.FromHours(12);

    // False only in Development over plain http: cookie names without __Host- and Secure only on HTTPS requests.
    public bool SecureCookies { get; set; } = true;
}
