using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Dalamud.Game.Text;
using Dalamud.Game.Text.SeStringHandling;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using Dalamud.Bindings.ImGui;

namespace FFXIVBingo4All
{
    public sealed class Plugin : IDalamudPlugin
    {
        private const string DefaultServerBaseUrl = "http://localhost:3000";
        private const string DefaultClientBaseUrl = "http://localhost:3000";
        private static readonly Regex RollRegex =
            new(@"You roll a (\d+) \(1-75\)", RegexOptions.Compiled);

        public string Name => "FFXIV Bingo 4 All";

        [PluginService] private static IDalamudPluginInterface PluginInterface { get; set; } = null!;
        [PluginService] private static IChatGui ChatGui { get; set; } = null!;
        [PluginService] private static IObjectTable ObjectTable { get; set; } = null!;

        private readonly HttpClient httpClient = new()
        {
            Timeout = TimeSpan.FromSeconds(5),
        };

        private Configuration configuration = null!;
        private readonly Action openConfigAction;
        private readonly Action openMainAction;
        private bool isOpen = true;
        private bool showPlayersWindow = false;
        private bool showWebSettingsWindow = false;

        private string playerName = string.Empty;
        private int playerCardCount = 1;
        private string generatedLink = string.Empty;
        private int manualNumber = 1;
        private string webServerUrlInput = string.Empty;
        private string webClientUrlInput = string.Empty;

        public Plugin()
        {
            configuration = PluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
            configuration.Initialize(PluginInterface);
            webServerUrlInput = configuration.ServerBaseUrl;
            webClientUrlInput = configuration.ClientBaseUrl;

            ChatGui.ChatMessage += OnChatMessage;
            PluginInterface.UiBuilder.Draw += Draw;
            openConfigAction = () => isOpen = true;
            PluginInterface.UiBuilder.OpenConfigUi += openConfigAction;
            openMainAction = () => isOpen = true;
            PluginInterface.UiBuilder.OpenMainUi += openMainAction;

            if (configuration.CalledNumbers.Count > 0)
            {
                _ = Task.Run(SyncHostStateAsync);
            }
        }

        public void Dispose()
        {
            ChatGui.ChatMessage -= OnChatMessage;
            PluginInterface.UiBuilder.Draw -= Draw;
            PluginInterface.UiBuilder.OpenConfigUi -= openConfigAction;
            PluginInterface.UiBuilder.OpenMainUi -= openMainAction;
            httpClient.Dispose();
        }

        private void OnChatMessage(
            XivChatType type,
            int timestamp,
            ref SeString sender,
            ref SeString message,
            ref bool isHandled)
        {
            var text = message.TextValue;
            var match = RollRegex.Match(text);
            if (!match.Success)
            {
                return;
            }

            var senderName = sender.TextValue;
            var localName = ObjectTable.LocalPlayer?.Name.TextValue ?? string.Empty;
            if (!string.IsNullOrEmpty(senderName) &&
                !string.Equals(senderName, localName, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (!int.TryParse(match.Groups[1].Value, out var rolled))
            {
                return;
            }

            HandleCallNumber(rolled);
        }

        private void HandleCallNumber(int number)
        {
            if (number < 1 || number > 75)
            {
                return;
            }

            if (configuration.CalledNumbers.Contains(number))
            {
                ChatGui.PrintError("DUPLICATE ROLL! Reroll.");
                return;
            }

            configuration.CalledNumbers.Add(number);
            configuration.Save();

            _ = Task.Run(() => PostCallNumberAsync(number));
        }

        private async Task SyncHostStateAsync()
        {
            if (string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
            {
                return;
            }

            var payload = new
            {
                roomCode = configuration.CurrentRoomCode,
                calledNumbers = configuration.CalledNumbers,
            };

            await PostJsonAsync("/api/host-sync", payload).ConfigureAwait(false);
        }

        private async Task PostCallNumberAsync(int number)
        {
            if (string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
            {
                return;
            }

            var payload = new
            {
                roomCode = configuration.CurrentRoomCode,
                number,
            };

            await PostJsonAsync("/api/call-number", payload).ConfigureAwait(false);
        }

        private async Task PostJsonAsync(string path, object payload)
        {
            try
            {
                var json = JsonSerializer.Serialize(payload);
                using var content = new StringContent(json, Encoding.UTF8, "application/json");
                var serverBaseUrl = GetServerBaseUrl();
                await httpClient.PostAsync($"{serverBaseUrl}{path}", content).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Ignore network errors to avoid spamming chat.
            }
        }

        private void Draw()
        {
            if (!isOpen)
            {
                return;
            }

            if (!ImGui.Begin("Bingo Host", ref isOpen, ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.End();
                return;
            }

            DrawStats();
            ImGui.Separator();
            DrawSettings();
            ImGui.Separator();
            DrawPlayerGenerator();
            ImGui.Separator();
            DrawManualControl();

            ImGui.End();

            DrawPlayersWindow();
            DrawWebSettingsWindow();
        }

        private void DrawStats()
        {
            int totalCards = configuration.IssuedCards.Values.Sum(p => p.CardCount);
            int totalPot = totalCards * configuration.CostPerCard;
            float prizePool = totalPot * (configuration.PrizePercentage / 100f);

            ImGui.Text("Stats Dashboard");
            ImGui.Text($"Total Cards Sold: {totalCards}");
            ImGui.Text($"Total Pot: {totalPot}");
            ImGui.Text($"Prize Pool: {prizePool:0.##}");
        }

        private void DrawSettings()
        {
            ImGui.Text("Settings");
            bool changed = false;

            string roomCode = configuration.CurrentRoomCode;
            if (ImGui.InputText("Current Room Code", ref roomCode, 64))
            {
                configuration.CurrentRoomCode = roomCode.Trim();
                changed = true;
            }

            int cost = configuration.CostPerCard;
            if (ImGui.InputInt("Cost Per Card", ref cost))
            {
                configuration.CostPerCard = Math.Max(0, cost);
                changed = true;
            }

            float percentage = configuration.PrizePercentage;
            if (ImGui.SliderFloat("Prize Percentage", ref percentage, 0f, 100f, "%.1f%%"))
            {
                configuration.PrizePercentage = Math.Clamp(percentage, 0f, 100f);
                changed = true;
            }

            string letters = configuration.CustomHeaderLetters;
            if (ImGui.InputText("Custom Letters", ref letters, 6))
            {
                configuration.CustomHeaderLetters = NormalizeLetters(letters);
                changed = true;
            }

            var bg = configuration.BgColor;
            if (ImGui.ColorEdit4("BG Color", ref bg))
            {
                configuration.BgColor = bg;
                changed = true;
            }

            var card = configuration.CardColor;
            if (ImGui.ColorEdit4("Card Color", ref card))
            {
                configuration.CardColor = card;
                changed = true;
            }

            var header = configuration.HeaderColor;
            if (ImGui.ColorEdit4("Header Color", ref header))
            {
                configuration.HeaderColor = header;
                changed = true;
            }

            var text = configuration.TextColor;
            if (ImGui.ColorEdit4("Text Color", ref text))
            {
                configuration.TextColor = text;
                changed = true;
            }

            var daub = configuration.DaubColor;
            if (ImGui.ColorEdit4("Daub Color", ref daub))
            {
                configuration.DaubColor = daub;
                changed = true;
            }

            if (ImGui.Button("Web Settings"))
            {
                OpenWebSettingsWindow();
            }

            if (changed)
            {
                configuration.Save();
            }
        }

        private void DrawPlayerGenerator()
        {
            ImGui.Text("Player Generator");

            ImGui.InputText("Player Name", ref playerName, 64);
            ImGui.SliderInt("Card Count", ref playerCardCount, 1, 16);

            if (ImGui.Button("Generate Link"))
            {
                var seed = Guid.NewGuid().ToString();
                var letters = NormalizeLetters(configuration.CustomHeaderLetters);
                generatedLink = BuildClientUrl(seed, playerCardCount, letters);

                RemoveIssuedCardsForPlayer(playerName);
                configuration.IssuedCards[seed] = new PlayerData
                {
                    PlayerName = playerName.Trim(),
                    CardCount = playerCardCount,
                };
                configuration.Save();
            }

            if (!string.IsNullOrEmpty(generatedLink))
            {
                ImGui.InputText("Share Link", ref generatedLink, 512, ImGuiInputTextFlags.ReadOnly);
                if (ImGui.Button("Copy Link"))
                {
                    ImGui.SetClipboardText(generatedLink);
                }
            }

            if (ImGui.Button("Players Window"))
            {
                showPlayersWindow = true;
            }
        }

        private void DrawManualControl()
        {
            ImGui.Text("Manual Control");
            ImGui.InputInt("Call Number", ref manualNumber);

            if (ImGui.Button("Call Number"))
            {
                HandleCallNumber(manualNumber);
            }
        }

        private void DrawPlayersWindow()
        {
            if (!showPlayersWindow)
            {
                return;
            }

            if (!ImGui.Begin("Bingo Players", ref showPlayersWindow, ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.End();
                return;
            }

            if (configuration.IssuedCards.Count == 0)
            {
                ImGui.Text("No players have been issued cards.");
                ImGui.End();
                return;
            }

            var updates = new List<(string oldSeed, string playerName, int newCount)>();
            var entries = configuration.IssuedCards.ToList();

            foreach (var entry in entries)
            {
                var seed = entry.Key;
                var data = entry.Value;
                var letters = NormalizeLetters(configuration.CustomHeaderLetters);
                string link = BuildClientUrl(seed, data.CardCount, letters);

                ImGui.Separator();
                ImGui.Text(data.PlayerName);
                ImGui.Text($"Cards: {data.CardCount}");
                ImGui.InputText($"Link##{seed}", ref link, 512, ImGuiInputTextFlags.ReadOnly);

                if (ImGui.Button($"Copy##{seed}"))
                {
                    ImGui.SetClipboardText(link);
                }

                ImGui.SameLine();
                if (ImGui.Button($"+ Card##{seed}"))
                {
                    int next = Math.Min(data.CardCount + 1, 16);
                    if (next != data.CardCount)
                    {
                        updates.Add((seed, data.PlayerName, next));
                    }
                }

                ImGui.SameLine();
                if (ImGui.Button($"- Card##{seed}"))
                {
                    int next = data.CardCount - 1;
                    updates.Add((seed, data.PlayerName, Math.Max(0, next)));
                }

                ImGui.SameLine();
                if (ImGui.Button($"New Link##{seed}"))
                {
                    updates.Add((seed, data.PlayerName, data.CardCount));
                }
            }

            if (updates.Count > 0)
            {
                ApplyPlayerUpdates(updates);
                configuration.Save();
            }

            ImGui.End();
        }

        private void OpenWebSettingsWindow()
        {
            showWebSettingsWindow = true;
            webServerUrlInput = configuration.ServerBaseUrl;
            webClientUrlInput = configuration.ClientBaseUrl;
        }

        private void DrawWebSettingsWindow()
        {
            if (!showWebSettingsWindow)
            {
                return;
            }

            if (!ImGui.Begin("Web Settings", ref showWebSettingsWindow, ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.End();
                return;
            }

            ImGui.InputText("Server Base URL", ref webServerUrlInput, 512);
            ImGui.InputText("Client Base URL", ref webClientUrlInput, 512);

            if (ImGui.Button("Save"))
            {
                configuration.ServerBaseUrl = NormalizeBaseUrl(webServerUrlInput, DefaultServerBaseUrl);
                configuration.ClientBaseUrl = NormalizeBaseUrl(webClientUrlInput, DefaultClientBaseUrl);
                webServerUrlInput = configuration.ServerBaseUrl;
                webClientUrlInput = configuration.ClientBaseUrl;
                configuration.Save();
            }

            ImGui.SameLine();
            if (ImGui.Button("Reset Defaults"))
            {
                configuration.ServerBaseUrl = DefaultServerBaseUrl;
                configuration.ClientBaseUrl = DefaultClientBaseUrl;
                webServerUrlInput = configuration.ServerBaseUrl;
                webClientUrlInput = configuration.ClientBaseUrl;
                configuration.Save();
            }

            ImGui.End();
        }

        private void ApplyPlayerUpdates(IEnumerable<(string oldSeed, string playerName, int newCount)> updates)
        {
            foreach (var update in updates)
            {
                configuration.IssuedCards.Remove(update.oldSeed);
                if (update.newCount > 0)
                {
                    var newSeed = Guid.NewGuid().ToString();
                    configuration.IssuedCards[newSeed] = new PlayerData
                    {
                        PlayerName = update.playerName,
                        CardCount = update.newCount,
                    };
                }
            }
        }

        private void RemoveIssuedCardsForPlayer(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return;
            }

            var trimmed = name.Trim();
            var toRemove = configuration.IssuedCards
                .Where(entry => string.Equals(entry.Value.PlayerName, trimmed, StringComparison.OrdinalIgnoreCase))
                .Select(entry => entry.Key)
                .ToList();

            foreach (var seed in toRemove)
            {
                configuration.IssuedCards.Remove(seed);
            }
        }

        private static string NormalizeLetters(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "BINGO";
            }

            var trimmed = value.Trim();
            if (trimmed.Length > 5)
            {
                trimmed = trimmed.Substring(0, 5);
            }

            return trimmed.ToUpperInvariant();
        }

        private string BuildClientUrl(string seed, int count, string letters)
        {
            var bg = ColorToHex(configuration.BgColor);
            var card = ColorToHex(configuration.CardColor);
            var header = ColorToHex(configuration.HeaderColor);
            var text = ColorToHex(configuration.TextColor);
            var daub = ColorToHex(configuration.DaubColor);

            var url = AppendQueryParam(GetClientBaseUrl(), "seed", seed);
            url = AppendQueryParam(url, "count", count.ToString());
            url = AppendQueryParam(url, "letters", letters);
            url = AppendQueryParam(url, "bg", bg);
            url = AppendQueryParam(url, "card", card);
            url = AppendQueryParam(url, "header", header);
            url = AppendQueryParam(url, "text", text);
            url = AppendQueryParam(url, "daub", daub);
            url = AppendQueryParam(url, "server", GetServerBaseUrl());
            return url;
        }

        private static string ColorToHex(System.Numerics.Vector4 color)
        {
            int r = (int)MathF.Round(Math.Clamp(color.X, 0f, 1f) * 255f);
            int g = (int)MathF.Round(Math.Clamp(color.Y, 0f, 1f) * 255f);
            int b = (int)MathF.Round(Math.Clamp(color.Z, 0f, 1f) * 255f);
            return $"{r:X2}{g:X2}{b:X2}";
        }

        private string GetServerBaseUrl()
        {
            return NormalizeBaseUrl(configuration.ServerBaseUrl, DefaultServerBaseUrl);
        }

        private string GetClientBaseUrl()
        {
            return NormalizeBaseUrl(configuration.ClientBaseUrl, DefaultClientBaseUrl);
        }

        private static string NormalizeBaseUrl(string? value, string fallback)
        {
            var trimmed = (value ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(trimmed))
            {
                trimmed = fallback;
            }

            return trimmed.TrimEnd('/');
        }

        private static string AppendQueryParam(string url, string key, string value)
        {
            var separator = url.Contains("?") ? "&" : "?";
            return $"{url}{separator}{key}={Uri.EscapeDataString(value)}";
        }
    }
}
