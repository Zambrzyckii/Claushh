using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Claushh.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class LoginLimitKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_LoginAttempts_Ip_At",
                table: "LoginAttempts");

            migrationBuilder.AddColumn<string>(
                name: "LimitKey",
                table: "LoginAttempts",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.CreateIndex(
                name: "IX_LoginAttempts_LimitKey_At",
                table: "LoginAttempts",
                columns: new[] { "LimitKey", "At" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_LoginAttempts_LimitKey_At",
                table: "LoginAttempts");

            migrationBuilder.DropColumn(
                name: "LimitKey",
                table: "LoginAttempts");

            migrationBuilder.CreateIndex(
                name: "IX_LoginAttempts_Ip_At",
                table: "LoginAttempts",
                columns: new[] { "Ip", "At" });
        }
    }
}
