using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Numerics;
using System.Collections.Concurrent;
using System.Security.Cryptography;
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
            new(
                @"(?:Random!\s*)?You roll a (\d+)\s*\((?:1\s*-\s*75|out of 75)\)\.?",
                RegexOptions.Compiled | RegexOptions.IgnoreCase);

        public string Name => "FFXIV Bingo 4 All";

        [PluginService] private static IDalamudPluginInterface PluginInterface { get; set; } = null!;
        [PluginService] private static IChatGui ChatGui { get; set; } = null!;
        [PluginService] private static ICommandManager CommandManager { get; set; } = null!;
        [PluginService] private static IObjectTable ObjectTable { get; set; } = null!;
        [PluginService] private static IPluginLog PluginLog { get; set; } = null!;

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
        private bool showResetPopup = false;
        private bool showServerRoomsWindow = false;
        private bool showCalledBallsWindow = false;
        private bool showStartPopup = false;
        private bool showSkinWindow = false;
        private bool startRequested = false;
        private string lastRollStatus = string.Empty;
        private string lastPostStatus = string.Empty;
        private string lastGeneratedSeed = string.Empty;
        private readonly ConcurrentQueue<QueuedChat> chatQueue = new();
        private readonly Dictionary<string, Dictionary<int, HashSet<int>>> roomDaubs = new();
        private readonly object roomStateLock = new();
        private DateTime lastRoomStateFetch = DateTime.MinValue;
        private bool roomStateFetchInFlight = false;
        private string lastBingoDisplay = string.Empty;
        private long lastBingoTimestamp = 0;

        private readonly struct QueuedChat
        {
            public QueuedChat(string message, bool isError)
            {
                Message = message;
                IsError = isError;
            }

            public string Message { get; }
            public bool IsError { get; }
        }

        private string playerName = string.Empty;
        private int playerCardCount = 1;
        private string generatedLink = string.Empty;
        private int manualNumber = 1;
        private string webServerUrlInput = string.Empty;
        private string webClientUrlInput = string.Empty;
        private string adminKeyInput = string.Empty;
        private readonly object adminRoomsLock = new();
        private List<AdminRoomInfo> adminRooms = new();
        private bool adminRoomsLoading = false;
        private string adminRoomsStatus = string.Empty;
        private DateTime lastAdminRoomsFetch = DateTime.MinValue;
        private int broadcastCommandIndex = 0;
        private string broadcastCopyStatus = string.Empty;
        private string skinCopyStatus = string.Empty;
        private int gameTypeIndex = 0;
        private int resumeRoomIndex = -1;
        private string resumeRoomInput = string.Empty;

        private static readonly string[] BroadcastCommands = { "/yell", "/shout" };
        private static readonly string[] GameTypes =
        {
            "Single Line",
            "Two Lines",
            "Four Corners",
            "Blackout",
        };

        public Plugin()
        {
            configuration = PluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
            configuration.Initialize(PluginInterface);
            webServerUrlInput = configuration.ServerBaseUrl;
            webClientUrlInput = configuration.ClientBaseUrl;
            adminKeyInput = configuration.AdminKey;

            ChatGui.ChatMessage += OnChatMessage;
            PluginInterface.UiBuilder.Draw += Draw;
            openConfigAction = () => isOpen = true;
            PluginInterface.UiBuilder.OpenConfigUi += openConfigAction;
            openMainAction = () => isOpen = true;
            PluginInterface.UiBuilder.OpenMainUi += openMainAction;

            if (configuration.BingoActive &&
                (configuration.CalledNumbers.Count > 0 || configuration.IssuedCards.Count > 0))
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
            if (!configuration.BingoActive)
            {
                return;
            }

            var text = message.TextValue;
            if (text.StartsWith("[Bingo]", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            if (!text.Contains("You roll", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            var match = RollRegex.Match(text);
            if (!match.Success)
            {
                DebugChat($"Roll parse miss: \"{text}\"");
                return;
            }

            var senderName = sender.TextValue;
            var localName = ObjectTable.LocalPlayer?.Name.TextValue ?? string.Empty;
            if (!string.IsNullOrEmpty(senderName) &&
                !string.Equals(senderName, "You", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(senderName, localName, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (!int.TryParse(match.Groups[1].Value, out var rolled))
            {
                return;
            }

            manualNumber = rolled;
            DebugChat($"Roll detected: {rolled} (sender: {senderName}, type: {type})");
            TryHandleCallNumber(rolled, "roll");
        }

        private bool TryHandleCallNumber(int number, string source)
        {
            if (!configuration.BingoActive)
            {
                lastRollStatus = "Bingo is stopped.";
                return false;
            }

            if (number < 1 || number > 75)
            {
                lastRollStatus = $"Invalid roll ({number}).";
                return false;
            }

            if (configuration.CalledNumbers.Contains(number))
            {
                ChatGui.PrintError("DUPLICATE ROLL! Reroll.");
                lastRollStatus = "DUPLICATE NUMBER";
                return false;
            }

            configuration.CalledNumbers.Add(number);
            configuration.Save();
            lastRollStatus = $"Called {number} ({source}).";

            _ = Task.Run(() => PostCallNumberAsync(number));
            return true;
        }

        private void RollRandomNumber()
        {
            try
            {
                DebugChat("Rolling /random 75...");
                bool handled = CommandManager.ProcessCommand("/random 75");
                if (!handled)
                {
                    DebugChat("Command manager did not handle /random 75. Trying chat.");
                    if (!TrySendChatMessage("/random 75"))
                    {
                        RollLocally();
                    }
                }
            }
            catch (Exception ex)
            {
                DebugChat($"Failed to execute /random 75: {ex.Message}", true);
                if (!TrySendChatMessage("/random 75"))
                {
                    RollLocally();
                }
            }
        }

        private async Task SyncHostStateAsync()
        {
            if (!configuration.BingoActive)
            {
                return;
            }

            if (string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
            {
                lastPostStatus = "Missing room code.";
                DebugChat("Missing room code for host sync.");
                return;
            }

            var payload = new
            {
                roomCode = configuration.CurrentRoomCode,
                calledNumbers = configuration.CalledNumbers,
                allowedSeeds = configuration.IssuedCards.Keys.ToList(),
                allowedCards = configuration.IssuedCards.ToDictionary(
                    entry => entry.Key,
                    entry => Math.Clamp(entry.Value.CardCount, 1, 16)),
                costPerCard = configuration.CostPerCard,
                startingPot = configuration.StartingPot,
                prizePercentage = configuration.PrizePercentage,
                gameType = configuration.GameType,
            };

            PluginLog.Information(
                "Host sync: room={Room} count={Count}",
                configuration.CurrentRoomCode,
                configuration.CalledNumbers.Count);
            DebugChat(
                $"Host sync: room {configuration.CurrentRoomCode}, {configuration.CalledNumbers.Count} numbers.");
            var ok = await PostJsonAsync("/api/host-sync", payload).ConfigureAwait(false);
            lastPostStatus = ok ? "Host sync ok." : "Host sync failed.";
            DebugChat(ok ? "Host sync complete." : "Host sync failed.");
        }

        private async Task PostCallNumberAsync(int number)
        {
            if (!configuration.BingoActive)
            {
                return;
            }

            if (string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
            {
                lastPostStatus = "Missing room code.";
                DebugChat("Missing room code for call number.");
                return;
            }

            var payload = new
            {
                roomCode = configuration.CurrentRoomCode,
                number,
            };

            PluginLog.Information(
                "Call number: room={Room} number={Number}",
                configuration.CurrentRoomCode,
                number);
            lastPostStatus = $"Posting {number}...";
            DebugChat($"Posting {number} to room {configuration.CurrentRoomCode}...");
            var ok = await PostJsonAsync("/api/call-number", payload).ConfigureAwait(false);
            lastPostStatus = ok ? $"Posted {number}." : $"Post failed ({number}).";
            DebugChat(ok ? $"Posted {number}." : $"Failed to post {number}.");
            if (!ok)
            {
                DebugChat($"Failed to send {number} to server.", true);
            }
        }

        private async Task<bool> PostJsonAsync(string path, object payload)
        {
            try
            {
                var json = JsonSerializer.Serialize(payload);
                using var content = new StringContent(json, Encoding.UTF8, "application/json");
                var serverBaseUrl = GetServerBaseUrl();
                var url = $"{serverBaseUrl}{path}";
                var response = await httpClient.PostAsync(url, content).ConfigureAwait(false);
                PluginLog.Information("POST {Url} -> {Status}", url, response.StatusCode);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                PluginLog.Error(ex, "POST {Path} failed", path);
                DebugChat($"POST {path} failed: {ex.Message}");
                return false;
            }
        }

        private void Draw()
        {
            FlushChatQueue();
            MaybeRefreshRoomState();
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
            DrawServerRoomsWindow();
            DrawCalledBallsWindow();
            DrawStartPopup();
            DrawSkinWindow();
        }

        private void DrawStats()
        {
            int totalCards = configuration.IssuedCards.Values.Sum(p => p.CardCount);
            int totalPot = configuration.StartingPot + (totalCards * configuration.CostPerCard);
            float prizePool = totalPot * (configuration.PrizePercentage / 100f);

            ImGui.Text("Stats Dashboard");
            ImGui.Text($"Total Cards Sold: {totalCards}");
            ImGui.Text($"Total Pot: {totalPot}");
            ImGui.Text($"Prize Pool: {prizePool:0.##}");
            ImGui.Text($"Status: {(configuration.BingoActive ? "Running" : "Stopped")}");
            ImGui.Text($"Game Type: {configuration.GameType}");
            if (!string.IsNullOrWhiteSpace(lastBingoDisplay))
            {
                ImGui.TextColored(
                    new Vector4(1f, 0.82f, 0.45f, 1f),
                    $"Last Bingo: {lastBingoDisplay}");
            }
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

            bool bingoActive = configuration.BingoActive;
            if (ImGui.Checkbox("Bingo Active", ref bingoActive))
            {
                if (bingoActive)
                {
                    configuration.BingoActive = true;
                    configuration.Save();
                    startRequested = true;
                    OpenStartPopup();
                    lastRollStatus = "Select Start New Game or Resume.";
                }
                else
                {
                    StopBingo();
                }
            }

            int cost = configuration.CostPerCard;
            if (ImGui.InputInt("Cost Per Card", ref cost))
            {
                configuration.CostPerCard = Math.Max(0, cost);
                changed = true;
            }

            int startingPot = configuration.StartingPot;
            if (ImGui.InputInt("Starting Pot", ref startingPot))
            {
                configuration.StartingPot = Math.Max(0, startingPot);
                changed = true;
            }

            float percentage = configuration.PrizePercentage;
            if (ImGui.InputFloat("Prize Percentage", ref percentage, 0f, 0f, "%.1f"))
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

            string venueName = configuration.VenueName;
            if (ImGui.InputText("Venue/Event", ref venueName, 64))
            {
                configuration.VenueName = venueName.Trim();
                changed = true;
            }

            int currentGameIndex = Array.IndexOf(GameTypes, configuration.GameType);
            if (currentGameIndex < 0)
            {
                currentGameIndex = 0;
            }
            if (ImGui.Combo("Game Type", ref currentGameIndex, GameTypes, GameTypes.Length))
            {
                configuration.GameType = GameTypes[currentGameIndex];
                changed = true;
                if (configuration.BingoActive)
                {
                    _ = Task.Run(SyncHostStateAsync);
                }
            }

            if (ImGui.Button("Web Settings"))
            {
                OpenWebSettingsWindow();
            }

            ImGui.SameLine();
            if (ImGui.Button("Server Rooms"))
            {
                OpenServerRoomsWindow();
            }

            ImGui.SameLine();
            if (ImGui.Button("Called Balls"))
            {
                showCalledBallsWindow = true;
            }

            ImGui.SameLine();
            if (ImGui.Button("Skin Me"))
            {
                showSkinWindow = true;
                skinCopyStatus = string.Empty;
            }

            ImGui.SameLine();
            if (ImGui.Button("Reset Room & Tickets"))
            {
                showResetPopup = true;
                ImGui.OpenPopup("Reset Room");
            }

            if (showResetPopup)
            {
                DrawResetPopup();
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
            playerCardCount = Math.Clamp(playerCardCount, 1, 16);

            if (ImGui.Button("Generate Link"))
            {
                if (string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
                {
                    configuration.CurrentRoomCode = Guid.NewGuid().ToString();
                }

                var displayName = playerName.Trim();
                var ledgerName = NormalizePlayerName(displayName);
                var seed = Guid.NewGuid().ToString();
                var letters = NormalizeLetters(configuration.CustomHeaderLetters);
                generatedLink = BuildClientUrl(seed, playerCardCount, letters, displayName);
                lastGeneratedSeed = seed;

                RemoveIssuedCardsForPlayer(ledgerName);
                configuration.IssuedCards[seed] = new PlayerData
                {
                    PlayerName = ledgerName,
                    CardCount = playerCardCount,
                    ShortCode = string.Empty,
                };
                configuration.Save();
                _ = Task.Run(SyncHostStateAsync);
                _ = Task.Run(() => CreateShortLinkForSeedAsync(seed, playerCardCount, letters, displayName));
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

            bool outOfRange = manualNumber < 1 || manualNumber > 75;
            bool isDuplicate = configuration.CalledNumbers.Contains(manualNumber);
            if (!configuration.BingoActive || outOfRange || isDuplicate)
            {
                ImGui.BeginDisabled();
            }

            if (ImGui.Button("Call Number"))
            {
                TryHandleCallNumber(manualNumber, "manual");
            }

            if (!configuration.BingoActive || outOfRange || isDuplicate)
            {
                ImGui.EndDisabled();
            }

            if (isDuplicate)
            {
                ImGui.TextColored(new Vector4(1f, 0.35f, 0.35f, 1f), "DUPLICATE NUMBER");
            }

            if (!configuration.BingoActive)
            {
                ImGui.Text("Bingo is stopped.");
            }

            if (!string.IsNullOrWhiteSpace(lastRollStatus))
            {
                ImGui.Text($"Last Roll: {lastRollStatus}");
            }

            if (!string.IsNullOrWhiteSpace(lastPostStatus))
            {
                ImGui.Text($"Last Send: {lastPostStatus}");
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
                string link = !string.IsNullOrWhiteSpace(data.ShortCode)
                    ? BuildShortUrl(data.ShortCode)
                    : BuildClientUrl(seed, data.CardCount, letters, data.PlayerName);

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

                if (ImGui.CollapsingHeader($"Cards##{seed}"))
                {
                    DrawPlayerCards(seed, data.CardCount);
                }
            }

            if (updates.Count > 0)
            {
                ApplyPlayerUpdates(updates);
                configuration.Save();
                _ = Task.Run(SyncHostStateAsync);
            }

            ImGui.End();
        }

        private void OpenWebSettingsWindow()
        {
            showWebSettingsWindow = true;
            webServerUrlInput = configuration.ServerBaseUrl;
            webClientUrlInput = configuration.ClientBaseUrl;
            adminKeyInput = configuration.AdminKey;
        }

        private void OpenServerRoomsWindow()
        {
            showServerRoomsWindow = true;
            _ = Task.Run(FetchAdminRoomsAsync);
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
            ImGui.InputText("Admin Key", ref adminKeyInput, 128, ImGuiInputTextFlags.Password);

            if (ImGui.Button("Save"))
            {
                configuration.ServerBaseUrl = NormalizeBaseUrl(webServerUrlInput, DefaultServerBaseUrl);
                configuration.ClientBaseUrl = NormalizeBaseUrl(webClientUrlInput, DefaultClientBaseUrl);
                configuration.AdminKey = adminKeyInput.Trim();
                webServerUrlInput = configuration.ServerBaseUrl;
                webClientUrlInput = configuration.ClientBaseUrl;
                adminKeyInput = configuration.AdminKey;
                configuration.Save();
            }

            ImGui.SameLine();
            if (ImGui.Button("Reset Defaults"))
            {
                configuration.ServerBaseUrl = DefaultServerBaseUrl;
                configuration.ClientBaseUrl = DefaultClientBaseUrl;
                configuration.AdminKey = string.Empty;
                webServerUrlInput = configuration.ServerBaseUrl;
                webClientUrlInput = configuration.ClientBaseUrl;
                adminKeyInput = configuration.AdminKey;
                configuration.Save();
            }

            ImGui.End();
        }

        private void DrawResetPopup()
        {
            bool open = true;
            if (ImGui.BeginPopupModal("Reset Room", ref open, ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.Text("This clears all called numbers and issued cards.");
                ImGui.Text("A new room code will be created.");
                ImGui.Separator();
                ImGui.Text("Game Type");
                ImGui.Combo("##reset_game_type", ref gameTypeIndex, GameTypes, GameTypes.Length);
                ImGui.Separator();

                if (ImGui.Button("Reset Now"))
                {
                    configuration.GameType = GameTypes[gameTypeIndex];
                    configuration.CurrentRoomCode = Guid.NewGuid().ToString();
                    configuration.CalledNumbers.Clear();
                    configuration.IssuedCards.Clear();
                    generatedLink = string.Empty;
                    configuration.Save();
                    _ = Task.Run(SyncHostStateAsync);

                    showResetPopup = false;
                    ImGui.CloseCurrentPopup();
                }

                ImGui.SameLine();
                if (ImGui.Button("Cancel"))
                {
                    showResetPopup = false;
                    ImGui.CloseCurrentPopup();
                }

                ImGui.EndPopup();
            }
            else
            {
                showResetPopup = false;
            }
        }

        private void DrawSkinWindow()
        {
            if (!showSkinWindow)
            {
                return;
            }

            if (!ImGui.Begin("Skin Me", ref showSkinWindow, ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.End();
                return;
            }

            bool changed = false;

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

            var ball = configuration.BallColor;
            if (ImGui.ColorEdit4("Ball Color", ref ball))
            {
                configuration.BallColor = ball;
                changed = true;
            }

            if (ImGui.Button("SKIN ME"))
            {
                var skin = BuildSkinQueryString();
                ImGui.SetClipboardText(skin);
                skinCopyStatus = "Skin copied.";
            }

            if (!string.IsNullOrWhiteSpace(skinCopyStatus))
            {
                ImGui.Text(skinCopyStatus);
            }

            if (changed)
            {
                configuration.Save();
            }

            ImGui.End();
        }

        private void DrawServerRoomsWindow()
        {
            if (!showServerRoomsWindow)
            {
                return;
            }

            MaybeRefreshAdminRooms();
            if (!ImGui.Begin(
                "Server Rooms",
                ref showServerRoomsWindow,
                ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.End();
                return;
            }

            if (ImGui.Button("Refresh"))
            {
                _ = Task.Run(FetchAdminRoomsAsync);
            }

            if (!string.IsNullOrWhiteSpace(adminRoomsStatus))
            {
                ImGui.Text(adminRoomsStatus);
            }

            List<AdminRoomInfo> rooms;
            lock (adminRoomsLock)
            {
                rooms = new List<AdminRoomInfo>(adminRooms);
            }

            if (rooms.Count == 0 && !adminRoomsLoading)
            {
                ImGui.Text("No active rooms.");
            }

            if (ImGui.BeginTable(
                "rooms",
                7,
                ImGuiTableFlags.Borders | ImGuiTableFlags.SizingFixedFit))
            {
                ImGui.TableSetupColumn("Room");
                ImGui.TableSetupColumn("Called");
                ImGui.TableSetupColumn("Seeds");
                ImGui.TableSetupColumn("Daubs");
                ImGui.TableSetupColumn("Game");
                ImGui.TableSetupColumn("Updated");
                ImGui.TableSetupColumn("Actions");
                ImGui.TableHeadersRow();

                foreach (var room in rooms)
                {
                    ImGui.TableNextRow();
                    ImGui.TableSetColumnIndex(0);
                    ImGui.Text(room.RoomCode);
                    ImGui.TableSetColumnIndex(1);
                    ImGui.Text(room.CalledNumbersCount.ToString());
                    ImGui.TableSetColumnIndex(2);
                    ImGui.Text(room.AllowedSeedsCount.ToString());
                    ImGui.TableSetColumnIndex(3);
                    ImGui.Text(room.DaubPlayers.ToString());
                    ImGui.TableSetColumnIndex(4);
                    ImGui.Text(room.GameType);
                    ImGui.TableSetColumnIndex(5);
                    ImGui.Text(room.UpdatedAt);
                    ImGui.TableSetColumnIndex(6);
                    if (ImGui.Button($"Join##{room.RoomCode}"))
                    {
                        SelectRoom(room.RoomCode, false);
                    }

                    ImGui.SameLine();
                    if (ImGui.Button($"Resume##{room.RoomCode}"))
                    {
                        SelectRoom(room.RoomCode, true);
                    }

                    ImGui.SameLine();
                    if (ImGui.Button($"Close##{room.RoomCode}"))
                    {
                        _ = Task.Run(() => CloseAdminRoomAsync(room.RoomCode));
                    }
                }

                ImGui.EndTable();
            }

            ImGui.End();
        }

        private void OpenStartPopup()
        {
            showStartPopup = true;
            resumeRoomInput = configuration.CurrentRoomCode;
            gameTypeIndex = Array.IndexOf(GameTypes, configuration.GameType);
            if (gameTypeIndex < 0)
            {
                gameTypeIndex = 0;
            }
            resumeRoomIndex = -1;
            _ = Task.Run(FetchAdminRoomsAsync);
            ImGui.OpenPopup("Start Bingo");
        }

        private void DrawStartPopup()
        {
            if (!showStartPopup)
            {
                return;
            }

            if (!ImGui.IsPopupOpen("Start Bingo"))
            {
                ImGui.OpenPopup("Start Bingo");
            }

            bool open = true;
            if (ImGui.BeginPopupModal("Start Bingo", ref open, ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.Text("Game Type");
                ImGui.Combo("##game_type", ref gameTypeIndex, GameTypes, GameTypes.Length);

                ImGui.Separator();
                ImGui.Text("Resume Room");

                List<AdminRoomInfo> rooms;
                lock (adminRoomsLock)
                {
                    rooms = new List<AdminRoomInfo>(adminRooms);
                }

                if (rooms.Count > 0)
                {
                    var roomLabels = rooms.Select(r => r.RoomCode).ToArray();
                    if (resumeRoomIndex < 0 || resumeRoomIndex >= roomLabels.Length)
                    {
                        resumeRoomIndex = 0;
                    }
                    ImGui.Combo("##resume_room", ref resumeRoomIndex, roomLabels, roomLabels.Length);
                    resumeRoomInput = roomLabels[resumeRoomIndex];
                }
                else
                {
                    ImGui.InputText("Room Code", ref resumeRoomInput, 64);
                }

                ImGui.Separator();
                if (ImGui.Button("Start New Game"))
                {
                    configuration.GameType = GameTypes[gameTypeIndex];
                    StartNewBingo();
                    startRequested = false;
                    showStartPopup = false;
                    ImGui.CloseCurrentPopup();
                }

                ImGui.SameLine();
                bool hasResumeRoom = !string.IsNullOrWhiteSpace(resumeRoomInput);
                if (!hasResumeRoom)
                {
                    ImGui.BeginDisabled();
                }

                if (ImGui.Button("Resume Selected"))
                {
                    configuration.GameType = GameTypes[gameTypeIndex];
                    SelectRoom(resumeRoomInput.Trim(), true);
                    startRequested = false;
                    showStartPopup = false;
                    ImGui.CloseCurrentPopup();
                }

                if (!hasResumeRoom)
                {
                    ImGui.EndDisabled();
                }

                ImGui.SameLine();
                if (ImGui.Button("Cancel"))
                {
                    if (startRequested)
                    {
                        configuration.BingoActive = false;
                        configuration.Save();
                        startRequested = false;
                    }
                    showStartPopup = false;
                    ImGui.CloseCurrentPopup();
                }

                ImGui.EndPopup();
            }
            else
            {
                showStartPopup = false;
            }
        }

        private void DrawCalledBallsWindow()
        {
            if (!showCalledBallsWindow)
            {
                return;
            }

            if (!ImGui.Begin(
                "Called Balls",
                ref showCalledBallsWindow,
                ImGuiWindowFlags.AlwaysAutoResize))
            {
                ImGui.End();
                return;
            }

            int lastCalled = configuration.CalledNumbers.Count > 0
                ? configuration.CalledNumbers[^1]
                : 0;
            bool hasLast = lastCalled > 0;
            string lastLabel = FormatBallLabel(lastCalled, configuration.CustomHeaderLetters);

            ImGui.Text("Broadcast Command");
            ImGui.SameLine();
            ImGui.SetNextItemWidth(120);
            ImGui.Combo("##broadcast", ref broadcastCommandIndex, BroadcastCommands, BroadcastCommands.Length);

            ImGui.Text("Last Called");
            ImGui.SetWindowFontScale(1.6f);
            if (ImGui.Button(hasLast ? lastLabel : "--", new Vector2(140, 0)))
            {
                if (hasLast)
                {
                    string command = $"{BroadcastCommands[broadcastCommandIndex]} {lastLabel}";
                    ImGui.SetClipboardText(command);
                    broadcastCopyStatus = $"Copied: {command}";
                }
                else
                {
                    broadcastCopyStatus = "No number has been called yet.";
                }
            }
            ImGui.SetWindowFontScale(1.0f);

            if (!string.IsNullOrWhiteSpace(broadcastCopyStatus))
            {
                ImGui.Text(broadcastCopyStatus);
            }

            var calledSet = new HashSet<int>(configuration.CalledNumbers);
            var headerLetters = NormalizeLetters(configuration.CustomHeaderLetters);
            if (ImGui.BeginTable(
                "called_grid",
                5,
                ImGuiTableFlags.Borders | ImGuiTableFlags.SizingFixedFit))
            {
                for (int col = 0; col < 5; col++)
                {
                    ImGui.TableSetupColumn(headerLetters[col].ToString());
                }
                ImGui.TableHeadersRow();

                for (int row = 0; row < 15; row++)
                {
                    ImGui.TableNextRow();
                    for (int col = 0; col < 5; col++)
                    {
                        int number = (col * 15) + row + 1;
                        bool called = calledSet.Contains(number);
                        ImGui.TableSetColumnIndex(col);
                        if (called)
                        {
                            ImGui.PushStyleColor(ImGuiCol.Button, configuration.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.ButtonHovered, configuration.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.ButtonActive, configuration.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.Text, new Vector4(0f, 0f, 0f, 1f));
                        }

                        ImGui.Button(number.ToString(), new Vector2(40, 0));

                        if (called)
                        {
                            ImGui.PopStyleColor(4);
                        }
                    }
                }

                ImGui.EndTable();
            }

            ImGui.End();
        }

        private void ApplyPlayerUpdates(IEnumerable<(string oldSeed, string playerName, int newCount)> updates)
        {
            foreach (var update in updates)
            {
                RemoveIssuedCardsForPlayer(update.playerName);
                if (update.newCount > 0)
                {
                    var newSeed = Guid.NewGuid().ToString();
                    var playerName = NormalizePlayerName(update.playerName);
                    configuration.IssuedCards[newSeed] = new PlayerData
                    {
                        PlayerName = playerName,
                        CardCount = update.newCount,
                        ShortCode = string.Empty,
                    };
                    _ = Task.Run(() =>
                        CreateShortLinkForSeedAsync(newSeed, update.newCount, NormalizeLetters(configuration.CustomHeaderLetters), playerName));
                }
            }
        }

        private void RemoveIssuedCardsForPlayer(string name)
        {
            var trimmed = NormalizePlayerName(name);
            var toRemove = configuration.IssuedCards
                .Where(entry =>
                    string.Equals(
                        NormalizePlayerName(entry.Value.PlayerName),
                        trimmed,
                        StringComparison.OrdinalIgnoreCase))
                .Select(entry => entry.Key)
                .ToList();

            foreach (var seed in toRemove)
            {
                configuration.IssuedCards.Remove(seed);
            }
        }

        private static string NormalizePlayerName(string? name)
        {
            var trimmed = (name ?? string.Empty).Trim();
            return string.IsNullOrEmpty(trimmed) ? "Guest" : trimmed;
        }

        private static string NormalizeLetters(string value)
        {
            const string fallback = "BINGO";
            if (string.IsNullOrWhiteSpace(value))
            {
                return fallback;
            }

            var trimmed = value.Trim().ToUpperInvariant();
            if (trimmed.Length >= 5)
            {
                return trimmed.Substring(0, 5);
            }

            var letters = fallback.ToCharArray();
            for (int i = 0; i < trimmed.Length; i++)
            {
                letters[i] = trimmed[i];
            }

            return new string(letters);
        }

        private string BuildClientUrl(string seed, int count, string letters, string? player)
        {
            var bg = ColorToHex(configuration.BgColor);
            var card = ColorToHex(configuration.CardColor);
            var header = ColorToHex(configuration.HeaderColor);
            var text = ColorToHex(configuration.TextColor);
            var daub = ColorToHex(configuration.DaubColor);
            var ball = ColorToHex(configuration.BallColor);
            var venue = configuration.VenueName?.Trim();

            var url = AppendQueryParam(GetClientBaseUrl(), "seed", seed);
            url = AppendQueryParam(url, "count", count.ToString());
            url = AppendQueryParam(url, "letters", letters);
            if (!string.IsNullOrWhiteSpace(venue))
            {
                url = AppendQueryParam(url, "title", venue);
            }
            url = AppendQueryParam(url, "bg", bg);
            url = AppendQueryParam(url, "card", card);
            url = AppendQueryParam(url, "header", header);
            url = AppendQueryParam(url, "text", text);
            url = AppendQueryParam(url, "daub", daub);
            url = AppendQueryParam(url, "ball", ball);
            url = AppendQueryParam(url, "server", GetServerBaseUrl());
            if (!string.IsNullOrWhiteSpace(player))
            {
                url = AppendQueryParam(url, "player", player.Trim());
            }
            if (!string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
            {
                url = AppendQueryParam(url, "room", configuration.CurrentRoomCode);
            }
            return url;
        }

        private Dictionary<string, object?> BuildLinkPayload(
            string seed,
            int count,
            string letters,
            string? player)
        {
            var payload = new Dictionary<string, object?>
            {
                ["seed"] = seed,
                ["count"] = Math.Clamp(count, 1, 16),
                ["letters"] = letters,
                ["player"] = string.IsNullOrWhiteSpace(player) ? null : player.Trim(),
                ["title"] = string.IsNullOrWhiteSpace(configuration.VenueName)
                    ? null
                    : configuration.VenueName.Trim(),
                ["room"] = string.IsNullOrWhiteSpace(configuration.CurrentRoomCode)
                    ? null
                    : configuration.CurrentRoomCode.Trim(),
                ["game"] = configuration.GameType,
                ["bg"] = ColorToHex(configuration.BgColor),
                ["card"] = ColorToHex(configuration.CardColor),
                ["header"] = ColorToHex(configuration.HeaderColor),
                ["text"] = ColorToHex(configuration.TextColor),
                ["daub"] = ColorToHex(configuration.DaubColor),
                ["ball"] = ColorToHex(configuration.BallColor),
                ["server"] = GetServerBaseUrl(),
            };

            return payload;
        }

        private string BuildShortUrl(string code)
        {
            return $"{GetServerBaseUrl()}/l/{code}";
        }

        private async Task<string> CreateShortLinkAsync(Dictionary<string, object?> payload)
        {
            try
            {
                var adminKey = configuration.AdminKey?.Trim();
                if (string.IsNullOrWhiteSpace(adminKey))
                {
                    DebugChat("Admin key is required for short links.");
                    return string.Empty;
                }

                var cleaned = payload
                    .Where(entry =>
                        entry.Value != null &&
                        !(entry.Value is string text && string.IsNullOrWhiteSpace(text)))
                    .ToDictionary(entry => entry.Key, entry => entry.Value!);

                var json = JsonSerializer.Serialize(cleaned);
                using var request = new HttpRequestMessage(
                    HttpMethod.Post,
                    $"{GetServerBaseUrl()}/api/links");
                request.Headers.Add("x-admin-key", adminKey);
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
                var response = await httpClient.SendAsync(request).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    DebugChat($"Short link failed ({response.StatusCode}).");
                    return string.Empty;
                }

                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("code", out var codeEl))
                {
                    return codeEl.GetString() ?? string.Empty;
                }
            }
            catch (Exception ex)
            {
                DebugChat($"Short link failed: {ex.Message}", true);
            }

            return string.Empty;
        }

        private async Task CreateShortLinkForSeedAsync(
            string seed,
            int count,
            string letters,
            string? player)
        {
            var payload = BuildLinkPayload(seed, count, letters, player);
            var code = await CreateShortLinkAsync(payload).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(code))
            {
                return;
            }

            if (configuration.IssuedCards.TryGetValue(seed, out var data))
            {
                data.ShortCode = code;
                configuration.Save();
            }

            if (seed == lastGeneratedSeed)
            {
                generatedLink = BuildShortUrl(code);
            }
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

        private static string FormatBallLabel(int number, string letters)
        {
            if (number < 1 || number > 75)
            {
                return "--";
            }

            var normalized = NormalizeLetters(letters);
            int index = (number - 1) / 15;
            char letter = normalized[index];
            return $"{letter} - {number}";
        }

        private string BuildSkinQueryString()
        {
            var bg = ColorToHex(configuration.BgColor);
            var card = ColorToHex(configuration.CardColor);
            var header = ColorToHex(configuration.HeaderColor);
            var text = ColorToHex(configuration.TextColor);
            var daub = ColorToHex(configuration.DaubColor);
            var ball = ColorToHex(configuration.BallColor);

            return $"bg={bg}&card={card}&header={header}&text={text}&daub={daub}&ball={ball}";
        }

        private void DebugChat(string message, bool isError = false)
        {
            chatQueue.Enqueue(new QueuedChat(message, isError));
        }

        private bool TrySendChatMessage(string command)
        {
            try
            {
                var method = ChatGui.GetType().GetMethod("SendMessage");
                if (method == null)
                {
                    DebugChat("Chat send is unavailable in this API.", true);
                    return false;
                }

                method.Invoke(ChatGui, new object[] { command });
                DebugChat("Sent command via chat.");
                return true;
            }
            catch (Exception ex)
            {
                DebugChat($"Chat send failed: {ex.Message}", true);
                return false;
            }
        }

        private void RollLocally()
        {
            int roll = RandomNumberGenerator.GetInt32(1, 76);
            DebugChat($"Local roll: {roll}.");
            manualNumber = roll;
            TryHandleCallNumber(roll, "local");
        }

        private void FlushChatQueue()
        {
            while (chatQueue.TryDequeue(out var item))
            {
                if (item.IsError)
                {
                    ChatGui.PrintError($"[Bingo] {item.Message}");
                }
                else
                {
                    ChatGui.Print($"[Bingo] {item.Message}");
                }
            }
        }

        private void MaybeRefreshAdminRooms()
        {
            if (adminRoomsLoading)
            {
                return;
            }

            if (DateTime.UtcNow - lastAdminRoomsFetch < TimeSpan.FromSeconds(5))
            {
                return;
            }

            lastAdminRoomsFetch = DateTime.UtcNow;
            _ = Task.Run(FetchAdminRoomsAsync);
        }

        private async Task FetchAdminRoomsAsync()
        {
            if (adminRoomsLoading)
            {
                return;
            }

            adminRoomsLoading = true;
            adminRoomsStatus = "Loading rooms...";
            try
            {
                var adminKey = configuration.AdminKey?.Trim();
                if (string.IsNullOrWhiteSpace(adminKey))
                {
                    adminRoomsStatus = "Admin key is required.";
                    return;
                }

                var serverBaseUrl = GetServerBaseUrl();
                using var request = new HttpRequestMessage(
                    HttpMethod.Get,
                    $"{serverBaseUrl}/api/admin/rooms");
                request.Headers.Add("x-admin-key", adminKey);
                var response = await httpClient.SendAsync(request).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    adminRoomsStatus = $"Failed to load rooms ({response.StatusCode}).";
                    return;
                }

                var json = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("rooms", out var roomsEl) ||
                    roomsEl.ValueKind != JsonValueKind.Array)
                {
                    adminRoomsStatus = "No rooms data returned.";
                    return;
                }

                var rooms = new List<AdminRoomInfo>();
                foreach (var roomEl in roomsEl.EnumerateArray())
                {
                    var info = new AdminRoomInfo
                    {
                        RoomCode = roomEl.GetProperty("roomCode").GetString() ?? string.Empty,
                        CalledNumbersCount = roomEl.GetProperty("calledNumbersCount").GetInt32(),
                        AllowedSeedsCount = roomEl.GetProperty("allowedSeedsCount").GetInt32(),
                        DaubPlayers = roomEl.GetProperty("daubPlayers").GetInt32(),
                        GameType = roomEl.TryGetProperty("gameType", out var gameEl)
                            ? gameEl.GetString() ?? "-"
                            : "-",
                        UpdatedAt = FormatTimestamp(roomEl, "updatedAt"),
                    };
                    rooms.Add(info);
                }

                lock (adminRoomsLock)
                {
                    adminRooms = rooms;
                }

                var now = DateTime.Now.ToString("HH:mm:ss");
                adminRoomsStatus = $"Last update: {now}";
            }
            catch (Exception)
            {
                adminRoomsStatus = "Failed to load rooms.";
            }
            finally
            {
                adminRoomsLoading = false;
            }
        }

        private async Task CloseAdminRoomAsync(string roomCode)
        {
            try
            {
                var adminKey = configuration.AdminKey?.Trim();
                if (string.IsNullOrWhiteSpace(adminKey))
                {
                    adminRoomsStatus = "Admin key is required.";
                    return;
                }

                var serverBaseUrl = GetServerBaseUrl();
                var payload = JsonSerializer.Serialize(new { roomCode });
                using var request = new HttpRequestMessage(
                    HttpMethod.Post,
                    $"{serverBaseUrl}/api/admin/rooms/close");
                request.Headers.Add("x-admin-key", adminKey);
                request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
                var response = await httpClient.SendAsync(request).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    adminRoomsStatus = $"Failed to close room ({response.StatusCode}).";
                    return;
                }

                _ = Task.Run(FetchAdminRoomsAsync);
            }
            catch (Exception)
            {
                adminRoomsStatus = "Failed to close room.";
            }
        }

        private void StartNewBingo()
        {
            configuration.BingoActive = true;
            configuration.CurrentRoomCode = Guid.NewGuid().ToString();
            configuration.CalledNumbers.Clear();
            configuration.IssuedCards.Clear();
            generatedLink = string.Empty;
            lastGeneratedSeed = string.Empty;
            lastRollStatus = string.Empty;
            lastPostStatus = string.Empty;
            lastBingoDisplay = string.Empty;
            lastBingoTimestamp = 0;
            lock (roomStateLock)
            {
                roomDaubs.Clear();
            }
            configuration.Save();
            _ = Task.Run(SyncHostStateAsync);
        }

        private void StopBingo()
        {
            configuration.BingoActive = false;
            configuration.CurrentRoomCode = string.Empty;
            configuration.Save();
        }

        private void SelectRoom(string roomCode, bool activate)
        {
            configuration.CurrentRoomCode = roomCode;
            configuration.BingoActive = activate;
            configuration.Save();
            _ = Task.Run(() => FetchRoomStateAsync(true));
        }

        private static string FormatTimestamp(JsonElement parent, string propertyName)
        {
            if (!parent.TryGetProperty(propertyName, out var prop))
            {
                return "-";
            }

            if (prop.ValueKind == JsonValueKind.Null)
            {
                return "-";
            }

            if (!prop.TryGetInt64(out var timestamp) || timestamp <= 0)
            {
                return "-";
            }

            var time = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).ToLocalTime();
            return time.ToString("HH:mm:ss");
        }

        private sealed class AdminRoomInfo
        {
            public string RoomCode { get; set; } = string.Empty;
            public int CalledNumbersCount { get; set; }
            public int AllowedSeedsCount { get; set; }
            public int DaubPlayers { get; set; }
            public string GameType { get; set; } = "-";
            public string UpdatedAt { get; set; } = "-";
        }

        private void MaybeRefreshRoomState()
        {
            if (roomStateFetchInFlight)
            {
                return;
            }

            if (string.IsNullOrWhiteSpace(configuration.CurrentRoomCode))
            {
                return;
            }

            if (DateTime.UtcNow - lastRoomStateFetch < TimeSpan.FromSeconds(5))
            {
                return;
            }

            roomStateFetchInFlight = true;
            _ = Task.Run(async () =>
            {
                try
                {
                    await FetchRoomStateAsync(false).ConfigureAwait(false);
                }
                finally
                {
                    roomStateFetchInFlight = false;
                    lastRoomStateFetch = DateTime.UtcNow;
                }
            });
        }

        private async Task FetchRoomStateAsync(bool updateCalledNumbers)
        {
            try
            {
                var serverBaseUrl = GetServerBaseUrl();
                var roomCode = Uri.EscapeDataString(configuration.CurrentRoomCode);
                var response = await httpClient
                    .GetAsync($"{serverBaseUrl}/api/room-state?roomCode={roomCode}")
                    .ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    return;
                }

                var json = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("ok", out var okEl) || !okEl.GetBoolean())
                {
                    return;
                }

                var newDaubs = new Dictionary<string, Dictionary<int, HashSet<int>>>();
                if (root.TryGetProperty("daubs", out var daubsEl) &&
                    daubsEl.ValueKind == JsonValueKind.Object)
                {
                    foreach (var seedProp in daubsEl.EnumerateObject())
                    {
                        var cardMap = new Dictionary<int, HashSet<int>>();
                        if (seedProp.Value.ValueKind == JsonValueKind.Object)
                        {
                            foreach (var cardProp in seedProp.Value.EnumerateObject())
                            {
                                if (!int.TryParse(cardProp.Name, out var cardIndex))
                                {
                                    continue;
                                }

                                if (cardProp.Value.ValueKind != JsonValueKind.Array)
                                {
                                    continue;
                                }

                                var set = new HashSet<int>();
                                foreach (var numEl in cardProp.Value.EnumerateArray())
                                {
                                    if (numEl.TryGetInt32(out var num))
                                    {
                                        set.Add(num);
                                    }
                                }
                                cardMap[cardIndex] = set;
                            }
                        }
                        newDaubs[seedProp.Name] = cardMap;
                    }
                }

                lock (roomStateLock)
                {
                    roomDaubs.Clear();
                    foreach (var entry in newDaubs)
                    {
                        roomDaubs[entry.Key] = entry.Value;
                    }
                }

                if (updateCalledNumbers &&
                    root.TryGetProperty("calledNumbers", out var calledEl) &&
                    calledEl.ValueKind == JsonValueKind.Array)
                {
                    var called = new List<int>();
                    foreach (var numEl in calledEl.EnumerateArray())
                    {
                        if (numEl.TryGetInt32(out var num))
                        {
                            called.Add(num);
                        }
                    }
                    configuration.CalledNumbers = called;
                    configuration.Save();
                }

                if (root.TryGetProperty("lastBingo", out var bingoEl) &&
                    bingoEl.ValueKind == JsonValueKind.Object)
                {
                    long timestamp = 0;
                    if (bingoEl.TryGetProperty("timestamp", out var tsEl) &&
                        tsEl.TryGetInt64(out var ts))
                    {
                        timestamp = ts;
                    }

                    string name = "Unknown";
                    if (bingoEl.TryGetProperty("name", out var nameEl))
                    {
                        name = nameEl.GetString() ?? "Unknown";
                    }

                    if (timestamp > 0 && timestamp != lastBingoTimestamp)
                    {
                        lastBingoTimestamp = timestamp;
                        var time = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).ToLocalTime();
                        lastBingoDisplay = $"{name} @ {time:HH:mm:ss}";
                    }
                }
            }
            catch (Exception)
            {
                // Ignore state fetch errors.
            }
        }

        private void DrawPlayerCards(string seed, int cardCount)
        {
            for (int cardIndex = 0; cardIndex < cardCount; cardIndex++)
            {
                ImGui.Text($"Card {cardIndex + 1}");
                var grid = GenerateCardGrid(seed, cardIndex);
                HashSet<int> daubed = new();
                lock (roomStateLock)
                {
                    if (roomDaubs.TryGetValue(seed, out var cardMap) &&
                        cardMap.TryGetValue(cardIndex, out var stored))
                    {
                        daubed = new HashSet<int>(stored);
                    }
                }

                if (ImGui.BeginTable(
                    $"card##{seed}_{cardIndex}",
                    5,
                    ImGuiTableFlags.Borders | ImGuiTableFlags.SizingFixedFit))
                {
                    for (int row = 0; row < 5; row++)
                    {
                        ImGui.TableNextRow();
                        for (int col = 0; col < 5; col++)
                        {
                            ImGui.TableSetColumnIndex(col);
                            int? number = grid[row, col];
                            bool isFree = !number.HasValue;
                            bool isDaubed = isFree || daubed.Contains(number.GetValueOrDefault());

                            if (isDaubed)
                            {
                                ImGui.PushStyleColor(ImGuiCol.Button, configuration.DaubColor);
                                ImGui.PushStyleColor(ImGuiCol.ButtonHovered, configuration.DaubColor);
                                ImGui.PushStyleColor(ImGuiCol.ButtonActive, configuration.DaubColor);
                                ImGui.PushStyleColor(ImGuiCol.Text, new Vector4(0f, 0f, 0f, 1f));
                            }

                            string label = isFree ? "FREE" : number.Value.ToString();
                            ImGui.Button($"{label}##{seed}_{cardIndex}_{row}_{col}", new Vector2(40, 32));

                            if (isDaubed)
                            {
                                ImGui.PopStyleColor(4);
                            }
                        }
                    }
                    ImGui.EndTable();
                }
            }
        }

        private static int?[,] GenerateCardGrid(string masterSeed, int cardIndex)
        {
            string seed = $"{masterSeed}_{cardIndex}";
            var rng = new Mulberry32(HashSeed(seed));
            var columns = new List<int>[5];
            columns[0] = GenerateColumn(rng, 1, 15);
            columns[1] = GenerateColumn(rng, 16, 30);
            columns[2] = GenerateColumn(rng, 31, 45);
            columns[3] = GenerateColumn(rng, 46, 60);
            columns[4] = GenerateColumn(rng, 61, 75);

            var grid = new int?[5, 5];
            for (int row = 0; row < 5; row++)
            {
                for (int col = 0; col < 5; col++)
                {
                    if (row == 2 && col == 2)
                    {
                        grid[row, col] = null;
                    }
                    else
                    {
                        grid[row, col] = columns[col][row];
                    }
                }
            }
            return grid;
        }

        private static List<int> GenerateColumn(Mulberry32 rng, int start, int end)
        {
            var numbers = new List<int>();
            for (int i = start; i <= end; i++)
            {
                numbers.Add(i);
            }

            for (int i = numbers.Count - 1; i > 0; i--)
            {
                int j = (int)Math.Floor(rng.NextDouble() * (i + 1));
                (numbers[i], numbers[j]) = (numbers[j], numbers[i]);
            }

            return numbers.GetRange(0, 5);
        }

        private static uint HashSeed(string seed)
        {
            uint hash = 2166136261;
            foreach (char ch in seed)
            {
                hash ^= ch;
                hash = unchecked(hash * 16777619);
            }
            return hash;
        }

        private sealed class Mulberry32
        {
            private uint state;

            public Mulberry32(uint seed)
            {
                state = seed;
            }

            public double NextDouble()
            {
                uint t = state += 0x6D2B79F5;
                uint r = unchecked((t ^ (t >> 15)) * (t | 1));
                r ^= r + unchecked((r ^ (r >> 7)) * (r | 61));
                uint result = r ^ (r >> 14);
                return result / 4294967296.0;
            }
        }
    }
}
