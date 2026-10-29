// Hubs:AllowedOrigins (docs/ARCHITECTURE.md, "Backend", configuration): the exact origins the portal is served from. A
// hub request's Origin (HubOrigins) and a passkey's origin (IdentityPasskeyOptions.ValidateOrigin in Program.cs) must
// be one of them.
namespace Claushh.Api.Hubs;

public sealed class HubsOptions
{
    public string[] AllowedOrigins { get; set; } = [];
}
