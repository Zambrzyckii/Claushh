// A login session kept on the server. The browser holds only a random secret; the database keeps its SHA-256
// (docs/ARCHITECTURE.md, "Backend").
using Microsoft.AspNetCore.Identity;

namespace Claushh.Api.Auth;

public sealed class Session
{
    public Guid Id { get; set; }
    public required string UserId { get; set; }
    public IdentityUser User { get; set; } = null!;
    public required byte[] SecretHash { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastActivityAt { get; set; }
    public DateTimeOffset IdleExpiresAt { get; set; }
    public DateTimeOffset AbsoluteExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public required string Device { get; set; }
    public required string Ip { get; set; }
}
