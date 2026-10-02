// Hubs:AllowedOrigins (docs/ARCHITECTURE.md, "Backend", configuration): the only Origin values a hub request may carry.
namespace Claushh.Api.Hubs;

public sealed class HubsOptions
{
    public string[] AllowedOrigins { get; set; } = [];
}
