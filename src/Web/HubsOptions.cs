// Hubs:AllowedOrigins (docs/ARCHITECTURE.md, "Backend", configuration): the exact origins the portal is served from. A
// hub request's Origin (HubOrigins) and a passkey's origin (IdentityPasskeyOptions.ValidateOrigin in AuthModule) must
// be one of them.
namespace Claushh.Api.Web;

public sealed class HubsOptions
{
    public string[] AllowedOrigins { get; set; } = [];
}
