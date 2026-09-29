// EF Core context: Identity tables (AspNetUsers, ...) and login sessions. Schema changes only through migrations
// in Data/Migrations, applied at startup (Program.cs).
using Claushh.Api.Auth;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Data;

public sealed class ClaushhDbContext(DbContextOptions<ClaushhDbContext> options) : IdentityDbContext<IdentityUser>(options)
{
    public DbSet<Session> Sessions => Set<Session>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.Entity<Session>(session =>
        {
            session.HasIndex(s => s.SecretHash).IsUnique();
            session.HasOne(s => s.User).WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
