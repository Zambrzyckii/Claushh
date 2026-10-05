using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Claushh.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class LoginMethod : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Method",
                table: "LoginAttempts",
                type: "text",
                nullable: false,
                defaultValue: "password");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Method",
                table: "LoginAttempts");
        }
    }
}
