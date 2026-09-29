using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

// Checks the fixture itself: the migrated database, the seeded user and codes from Totp.cs.
public sealed class DatabaseTests(ApiFactory api)
{
    [Fact]
    public async Task Seeded_user_has_totp_enabled_and_accepts_a_generated_code()
    {
        await api.ResetAsync();
        await using var scope = api.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser>>();

        var user = await users.FindByNameAsync(ApiFactory.UserName);

        Assert.NotNull(user);
        Assert.True(user.TwoFactorEnabled);
        Assert.True(await users.CheckPasswordAsync(user, ApiFactory.Password));
        Assert.True(await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, api.CurrentTotp()));
    }
}
