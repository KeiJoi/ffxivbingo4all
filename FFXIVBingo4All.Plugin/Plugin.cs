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
using System.Globalization;
using Dalamud.Game.Text;
using Dalamud.Game.Text.SeStringHandling;
using Dalamud.Game.Command;
using Dalamud.Game.ClientState.Objects.Types;
using Dalamud.Game.ClientState.Objects.Enums;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using Dalamud.Bindings.ImGui;

namespace FFXIVBingo4All
{
    public sealed class Plugin : IDalamudPlugin
    {
        private const string DefaultServerBaseUrl = "https://ffxivbingo4all.onrender.com";
        private const string DefaultClientBaseUrl = "https://ffxivbingo4all.onrender.com";
        private static readonly Regex RollRegex =
            new(
                @"(?:Random!\s*)?You roll a (\d+)\s*\((?:1\s*-\s*75|out of 75)\)\.?",
                RegexOptions.Compiled | RegexOptions.IgnoreCase);

        public string Name => "FFXIV Bingo 4 All";

        [PluginService] private static IDalamudPluginInterface PluginInterface { get; set; } = null!;
        [PluginService] private static IChatGui ChatGui { get; set; } = null!;
        [PluginService] private static ICommandManager CommandManager { get; set; } = null!;
        [PluginService] private static IObjectTable ObjectTable { get; set; } = null!;
        [PluginService] private static ITargetManager TargetManager { get; set; } = null!;
        [PluginService] private static IPluginLog PluginLog { get; set; } = null!;

        private readonly HttpClient httpClient = new()
        {
            Timeout = TimeSpan.FromSeconds(5),
        };

        private Configuration configuration = null!;
        private GameState gameState = new();
        private readonly Action openConfigAction;
        private readonly Action openMainAction;
        private bool isOpen = false;
        private bool showPlayersWindow = false;
        private bool showWebSettingsWindow = false;
        private bool showResetPopup = false;
        private bool showServerRoomsWindow = false;
        private bool showCalledBallsWindow = false;
        private bool showStartPopup = false;
        private bool showSkinWindow = false;
        private bool parseRollsEnabled = false;
        private string lastRollStatus = string.Empty;
        private string lastPostStatus = string.Empty;
        private string lastGeneratedSeed = string.Empty;
        private readonly DateTime uiOpenBlockedUntil = DateTime.UtcNow.AddSeconds(5);
        private readonly ConcurrentQueue<QueuedChat> chatQueue = new();
        private readonly HashSet<string> openPlayerCardWindows = new();
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
        private string playerStatus = string.Empty;
        private string webServerUrlInput = string.Empty;
        private string webClientUrlInput = string.Empty;
        private string adminKeyInput = string.Empty;
        private string roomKeyInput = string.Empty;
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
            roomKeyInput = configuration.RoomKey;

            ChatGui.ChatMessage += OnChatMessage;
            CommandManager.AddHandler("/ffxivbingo4all", new CommandInfo(OnCommand)
            {
                HelpMessage = "Open the FFXIV Bingo host window.",
            });
            PluginInterface.UiBuilder.Draw += Draw;
            openConfigAction = RequestOpenFromUiBuilder;
            PluginInterface.UiBuilder.OpenConfigUi += openConfigAction;
            openMainAction = RequestOpenFromUiBuilder;
            PluginInterface.UiBuilder.OpenMainUi += openMainAction;
        }

        public void Dispose()
        {
            ChatGui.ChatMessage -= OnChatMessage;
            CommandManager.RemoveHandler("/ffxivbingo4all");
            PluginInterface.UiBuilder.Draw -= Draw;
            PluginInterface.UiBuilder.OpenConfigUi -= openConfigAction;
            PluginInterface.UiBuilder.OpenMainUi -= openMainAction;
            httpClient.Dispose();
        }

        private void OnCommand(string command, string args)
        {
            isOpen = true;
        }

        private void RequestOpenFromUiBuilder()
        {
            if (DateTime.UtcNow < uiOpenBlockedUntil)
            {
                return;
            }
            isOpen = true;
        }

        private void OnChatMessage(
            XivChatType type,
            int timestamp,
            ref SeString sender,
            ref SeString message,
            ref bool isHandled)
        {
            if (!parseRollsEnabled)
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

            DebugChat($"Roll detected: {rolled} (sender: {senderName}, type: {type})");
            TryHandleCallNumber(rolled, "roll");
        }

        private bool TryHandleCallNumber(int number, string source)
        {
            if (string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                lastRollStatus = "No active room.";
                return false;
            }

            if (number < 1 || number > 75)
            {
                lastRollStatus = $"Invalid roll ({number}).";
                return false;
            }

            if (gameState.CalledNumbers.Contains(number))
            {
                ChatGui.PrintError("DUPLICATE ROLL! Reroll.");
                lastRollStatus = "DUPLICATE NUMBER";
                return false;
            }

            gameState.CalledNumbers.Add(number);
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
            if (string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                lastPostStatus = "Missing room code.";
                DebugChat("Missing room code for host sync.");
                return;
            }

            var roomKey = configuration.RoomKey?.Trim();
            if (string.IsNullOrWhiteSpace(roomKey))
            {
                lastPostStatus = "Missing room key.";
                DebugChat("Missing room key for host sync.");
                return;
            }

            var payload = new
            {
                roomCode = gameState.RoomCode,
                roomKey,
                calledNumbers = gameState.CalledNumbers,
                allowedCards = gameState.IssuedCards.ToDictionary(
                    entry => entry.Key,
                    entry => Math.Clamp(entry.Value.CardCount, 1, 16)),
                players = gameState.IssuedCards.ToDictionary(
                    entry => entry.Key,
                    entry => new
                    {
                        name = entry.Value.PlayerName,
                        count = Math.Clamp(entry.Value.CardCount, 1, 16),
                        shortCode = entry.Value.ShortCode,
                    }),
                costPerCard = gameState.CostPerCard,
                startingPot = gameState.StartingPot,
                prizePercentage = gameState.PrizePercentage,
                gameType = gameState.GameType,
                letters = NormalizeLetters(gameState.CustomHeaderLetters),
                title = gameState.VenueName,
                bg = ColorToHex(gameState.BgColor),
                card = ColorToHex(gameState.CardColor),
                header = ColorToHex(gameState.HeaderColor),
                text = ColorToHex(gameState.TextColor),
                daub = ColorToHex(gameState.DaubColor),
                ball = ColorToHex(gameState.BallColor),
            };

            PluginLog.Information(
                "Host sync: room={Room} count={Count}",
                gameState.RoomCode,
                gameState.CalledNumbers.Count);
            DebugChat(
                $"Host sync: room {gameState.RoomCode}, {gameState.CalledNumbers.Count} numbers.");
            var ok = await PostJsonAsync("/api/host-sync", payload).ConfigureAwait(false);
            lastPostStatus = ok ? "Host sync ok." : "Host sync failed.";
            DebugChat(ok ? "Host sync complete." : "Host sync failed.");
        }

        private async Task PostCallNumberAsync(int number)
        {
            if (string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                lastPostStatus = "Missing room code.";
                DebugChat("Missing room code for call number.");
                return;
            }

            var payload = new
            {
                roomCode = gameState.RoomCode,
                number,
            };

            PluginLog.Information(
                "Call number: room={Room} number={Number}",
                gameState.RoomCode,
                number);
            lastPostStatus = $"Posting {number}...";
            DebugChat($"Posting {number} to room {gameState.RoomCode}...");
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
                parseRollsEnabled = false;
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
            DrawCallStatus();
            ImGui.Separator();
            DrawPlayerGenerator();

            ImGui.End();

            DrawPlayersWindow();
            DrawPlayerCardWindows();
            DrawWebSettingsWindow();
            DrawServerRoomsWindow();
            DrawCalledBallsWindow();
            DrawStartPopup();
            DrawSkinWindow();
        }

        private void DrawStats()
        {
            int totalCards = gameState.IssuedCards.Values.Sum(p => p.CardCount);
            int totalPot = gameState.StartingPot + (totalCards * gameState.CostPerCard);
            int prizePool = (int)MathF.Round(totalPot * (gameState.PrizePercentage / 100f));

            ImGui.Text("Stats Dashboard");
            ImGui.Text($"Ticket Cost: {FormatNumber(gameState.CostPerCard)}");
            ImGui.Text($"Starting Pot: {FormatNumber(gameState.StartingPot)}");
            ImGui.Text($"Total Cards Sold: {FormatNumber(totalCards)}");
            ImGui.Text($"Total Pot: {FormatNumber(totalPot)}");
            ImGui.Text($"Prize Pool: {FormatNumber(prizePool)}");
            ImGui.Text($"Prize Percentage: {gameState.PrizePercentage:0.##}%");
            ImGui.Text($"Roll Parse: {(parseRollsEnabled ? "On" : "Off")}");
            ImGui.Text($"Game Type: {gameState.GameType}");
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
            bool changedGame = false;
            bool roomCodeChanged = false;

            string roomCode = gameState.RoomCode;
            if (ImGui.InputText("Current Room Code", ref roomCode, 64))
            {
                gameState.RoomCode = roomCode.Trim();
                roomCodeChanged = true;
            }

            bool parseEnabled = parseRollsEnabled;
            if (ImGui.Checkbox("Parse /random 75", ref parseEnabled))
            {
                parseRollsEnabled = parseEnabled;
            }

            ImGui.SameLine();
            if (ImGui.Button("Room Control"))
            {
                OpenStartPopup();
                lastRollStatus = "Select Start New Game or Resume.";
            }

            if (string.IsNullOrWhiteSpace(configuration.RoomKey))
            {
                ImGui.TextColored(
                    new Vector4(1f, 0.35f, 0.35f, 1f),
                    "Room key is required to start or resume games.");
            }

            int cost = gameState.CostPerCard;
            if (ImGui.InputInt("Cost Per Card", ref cost))
            {
                gameState.CostPerCard = Math.Max(0, cost);
                changedGame = true;
            }

            int startingPot = gameState.StartingPot;
            if (ImGui.InputInt("Starting Pot", ref startingPot))
            {
                gameState.StartingPot = Math.Max(0, startingPot);
                changedGame = true;
            }

            float percentage = gameState.PrizePercentage;
            if (ImGui.InputFloat("Prize Percentage", ref percentage, 0f, 0f, "%.1f"))
            {
                gameState.PrizePercentage = Math.Clamp(percentage, 0f, 100f);
                changedGame = true;
            }

            string letters = gameState.CustomHeaderLetters;
            if (ImGui.InputText("Custom Letters", ref letters, 6))
            {
                gameState.CustomHeaderLetters = NormalizeLetters(letters);
                changedGame = true;
            }

            string venueName = gameState.VenueName;
            if (ImGui.InputText("Venue/Event", ref venueName, 64))
            {
                gameState.VenueName = venueName.Trim();
                changedGame = true;
            }

            int currentGameIndex = Array.IndexOf(GameTypes, gameState.GameType);
            if (currentGameIndex < 0)
            {
                currentGameIndex = 0;
            }
            if (ImGui.Combo("Game Type", ref currentGameIndex, GameTypes, GameTypes.Length))
            {
                gameState.GameType = GameTypes[currentGameIndex];
                changedGame = true;
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
                gameTypeIndex = Array.IndexOf(GameTypes, gameState.GameType);
                if (gameTypeIndex < 0)
                {
                    gameTypeIndex = 0;
                }
                ImGui.OpenPopup("Reset Room");
            }

            if (showResetPopup)
            {
                DrawResetPopup();
            }

            if (roomCodeChanged && !string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                _ = Task.Run(() => FetchRoomStateAsync(true));
            }
            else if (changedGame && !string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                _ = Task.Run(SyncHostStateAsync);
            }
        }

        private void DrawPlayerGenerator()
        {
            ImGui.Text("Player Generator");

            ImGui.InputText("Player Name", ref playerName, 64);
            ImGui.SameLine();
            if (ImGui.Button("Use Target"))
            {
                playerStatus = string.Empty;
                var target = TargetManager.Target as IGameObject;
                if (target == null)
                {
                    playerStatus = "Target a player to fill the name.";
                }
                else if (target.ObjectKind != ObjectKind.Player)
                {
                    playerStatus = "Target must be a player.";
                }
                else
                {
                    var targetName = ExtractFirstLastName(target.Name.TextValue);
                    if (string.IsNullOrWhiteSpace(targetName))
                    {
                        playerStatus = "Target name is not usable.";
                    }
                    else
                    {
                        playerName = targetName;
                    }
                }
            }
            ImGui.SliderInt("Card Count", ref playerCardCount, 1, 16);
            playerCardCount = Math.Clamp(playerCardCount, 1, 16);

            var trimmedName = playerName.Trim();
            bool nameValid = trimmedName.Length >= 3;
            if (!nameValid)
            {
                ImGui.BeginDisabled();
            }
            if (ImGui.Button("Generate Link"))
            {
                playerStatus = string.Empty;
                if (string.IsNullOrWhiteSpace(configuration.RoomKey))
                {
                    playerStatus = "Room key is required to run a game.";
                }
                else
                {
                if (string.IsNullOrWhiteSpace(gameState.RoomCode))
                {
                    gameState.RoomCode = Guid.NewGuid().ToString();
                }

                var displayName = trimmedName;
                if (displayName.Length < 3)
                {
                    playerStatus = "Player name must be at least 3 characters.";
                }
                else
                {
                    var ledgerName = NormalizePlayerName(displayName);
                    var seed = Guid.NewGuid().ToString();
                    var letters = NormalizeLetters(gameState.CustomHeaderLetters);
                    generatedLink = BuildClientUrl(seed, playerCardCount, letters, displayName);
                    lastGeneratedSeed = seed;

                    RemoveIssuedCardsForPlayer(ledgerName);
                    gameState.IssuedCards[seed] = new PlayerData
                    {
                        PlayerName = ledgerName,
                        CardCount = playerCardCount,
                        ShortCode = string.Empty,
                    };
                    _ = Task.Run(SyncHostStateAsync);
                    _ = Task.Run(() => CreateShortLinkForSeedAsync(seed, playerCardCount, letters, displayName));
                    playerName = string.Empty;
                    playerStatus = "Cards added.";
                }
                }
            }
            if (!nameValid)
            {
                ImGui.EndDisabled();
            }

            if (!string.IsNullOrWhiteSpace(playerStatus))
            {
                ImGui.Text(playerStatus);
            }
            else if (!nameValid && !string.IsNullOrWhiteSpace(trimmedName))
            {
                ImGui.Text("Player name must be at least 3 characters.");
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

        private void DrawCallStatus()
        {
            ImGui.Text("Call Status");

            if (string.Equals(lastRollStatus, "DUPLICATE NUMBER", StringComparison.OrdinalIgnoreCase))
            {
                ImGui.TextColored(new Vector4(1f, 0.35f, 0.35f, 1f), "DUPLICATE NUMBER");
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

            if (gameState.IssuedCards.Count == 0)
            {
                ImGui.Text("No players have been issued cards.");
                ImGui.End();
                return;
            }

            var updates = new List<(string oldSeed, string playerName, int newCount)>();
            var entries = gameState.IssuedCards.ToList();

            foreach (var entry in entries)
            {
                var seed = entry.Key;
                var data = entry.Value;
                var letters = NormalizeLetters(gameState.CustomHeaderLetters);
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

                ImGui.SameLine();
                if (ImGui.Button($"View Cards##{seed}"))
                {
                    OpenPlayerCardsWindow(seed, data.PlayerName, data.CardCount);
                }
            }

            if (updates.Count > 0)
            {
                ApplyPlayerUpdates(updates);
                _ = Task.Run(SyncHostStateAsync);
            }

            ImGui.End();
        }

        private void OpenPlayerCardsWindow(string seed, string playerName, int cardCount)
        {
            if (string.IsNullOrWhiteSpace(seed))
            {
                return;
            }

            openPlayerCardWindows.Add(seed);
        }

        private void DrawPlayerCardWindows()
        {
            if (openPlayerCardWindows.Count == 0)
            {
                return;
            }

            var toClose = new List<string>();
            foreach (var seed in openPlayerCardWindows)
            {
                if (!gameState.IssuedCards.TryGetValue(seed, out var data))
                {
                    toClose.Add(seed);
                    continue;
                }

                ImGui.SetNextWindowSize(new Vector2(600, 500), ImGuiCond.FirstUseEver);
                bool open = true;
                string title = $"{data.PlayerName} ({data.CardCount} Cards)##cards_{seed}";
                if (!ImGui.Begin(title, ref open))
                {
                    ImGui.End();
                    if (!open)
                    {
                        toClose.Add(seed);
                    }
                    continue;
                }

                float availableWidth = ImGui.GetContentRegionAvail().X;
                float cardWidth = 230f;
                int columns = Math.Max(1, (int)(availableWidth / cardWidth));
                int columnIndex = 0;

                for (int cardIndex = 0; cardIndex < data.CardCount; cardIndex++)
                {
                    if (columnIndex > 0)
                    {
                        ImGui.SameLine();
                    }

                    ImGui.BeginGroup();
                    ImGui.Text($"Card {cardIndex + 1}");
                    DrawSinglePlayerCard(seed, cardIndex);
                    ImGui.EndGroup();

                    columnIndex++;
                    if (columnIndex >= columns)
                    {
                        columnIndex = 0;
                    }
                }

                ImGui.End();
                if (!open)
                {
                    toClose.Add(seed);
                }
            }

            foreach (var seed in toClose)
            {
                openPlayerCardWindows.Remove(seed);
            }
        }

        private void OpenWebSettingsWindow()
        {
            showWebSettingsWindow = true;
            webServerUrlInput = configuration.ServerBaseUrl;
            webClientUrlInput = configuration.ClientBaseUrl;
            adminKeyInput = configuration.AdminKey;
            roomKeyInput = configuration.RoomKey;
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
            ImGui.InputText("Room Key", ref roomKeyInput, 128, ImGuiInputTextFlags.Password);

            if (ImGui.Button("Save"))
            {
                configuration.ServerBaseUrl = NormalizeBaseUrl(webServerUrlInput, DefaultServerBaseUrl);
                configuration.ClientBaseUrl = NormalizeBaseUrl(webClientUrlInput, DefaultClientBaseUrl);
                configuration.AdminKey = adminKeyInput.Trim();
                configuration.RoomKey = roomKeyInput.Trim();
                webServerUrlInput = configuration.ServerBaseUrl;
                webClientUrlInput = configuration.ClientBaseUrl;
                adminKeyInput = configuration.AdminKey;
                roomKeyInput = configuration.RoomKey;
                configuration.Save();
            }

            ImGui.SameLine();
            if (ImGui.Button("Reset Defaults"))
            {
                configuration.ServerBaseUrl = DefaultServerBaseUrl;
                configuration.ClientBaseUrl = DefaultClientBaseUrl;
                configuration.AdminKey = string.Empty;
                configuration.RoomKey = string.Empty;
                webServerUrlInput = configuration.ServerBaseUrl;
                webClientUrlInput = configuration.ClientBaseUrl;
                adminKeyInput = configuration.AdminKey;
                roomKeyInput = configuration.RoomKey;
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
                    gameState.GameType = GameTypes[gameTypeIndex];
                    gameState.RoomCode = Guid.NewGuid().ToString();
                    gameState.CalledNumbers.Clear();
                    gameState.IssuedCards.Clear();
                    generatedLink = string.Empty;
                    lastGeneratedSeed = string.Empty;
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

            var bg = gameState.BgColor;
            if (ImGui.ColorEdit4("BG Color", ref bg))
            {
                gameState.BgColor = bg;
                changed = true;
            }

            var card = gameState.CardColor;
            if (ImGui.ColorEdit4("Card Color", ref card))
            {
                gameState.CardColor = card;
                changed = true;
            }

            var header = gameState.HeaderColor;
            if (ImGui.ColorEdit4("Header Color", ref header))
            {
                gameState.HeaderColor = header;
                changed = true;
            }

            var text = gameState.TextColor;
            if (ImGui.ColorEdit4("Text Color", ref text))
            {
                gameState.TextColor = text;
                changed = true;
            }

            var daub = gameState.DaubColor;
            if (ImGui.ColorEdit4("Daub Color", ref daub))
            {
                gameState.DaubColor = daub;
                changed = true;
            }

            var ball = gameState.BallColor;
            if (ImGui.ColorEdit4("Ball Color", ref ball))
            {
                gameState.BallColor = ball;
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

            if (changed && !string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                _ = Task.Run(SyncHostStateAsync);
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
                        SelectRoom(room.RoomCode);
                    }

                    ImGui.SameLine();
                    if (ImGui.Button($"Resume##{room.RoomCode}"))
                    {
                        SelectRoom(room.RoomCode);
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
            resumeRoomInput = gameState.RoomCode;
            gameTypeIndex = Array.IndexOf(GameTypes, gameState.GameType);
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
                bool roomKeyMissing = string.IsNullOrWhiteSpace(configuration.RoomKey);
                if (roomKeyMissing)
                {
                    ImGui.TextColored(
                        new Vector4(1f, 0.35f, 0.35f, 1f),
                        "Set a Room Key before starting or resuming.");
                }

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
                if (roomKeyMissing)
                {
                    ImGui.BeginDisabled();
                }
                if (ImGui.Button("Start New Game"))
                {
                    gameState.GameType = GameTypes[gameTypeIndex];
                    StartNewBingo();
                    showStartPopup = false;
                    ImGui.CloseCurrentPopup();
                }
                if (roomKeyMissing)
                {
                    ImGui.EndDisabled();
                }

                ImGui.SameLine();
                bool hasResumeRoom = !string.IsNullOrWhiteSpace(resumeRoomInput);
                if (!hasResumeRoom)
                {
                    ImGui.BeginDisabled();
                }

                if (roomKeyMissing)
                {
                    ImGui.BeginDisabled();
                }
                if (ImGui.Button("Resume Selected"))
                {
                    gameState.GameType = GameTypes[gameTypeIndex];
                    SelectRoom(resumeRoomInput.Trim());
                    showStartPopup = false;
                    ImGui.CloseCurrentPopup();
                }
                if (roomKeyMissing)
                {
                    ImGui.EndDisabled();
                }

                if (!hasResumeRoom)
                {
                    ImGui.EndDisabled();
                }

                ImGui.SameLine();
                if (ImGui.Button("Cancel"))
                {
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

            int lastCalled = gameState.CalledNumbers.Count > 0
                ? gameState.CalledNumbers[^1]
                : 0;
            bool hasLast = lastCalled > 0;
            string lastLabel = FormatBallLabel(lastCalled, gameState.CustomHeaderLetters);

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

            var calledSet = new HashSet<int>(gameState.CalledNumbers);
            var headerLetters = NormalizeLetters(gameState.CustomHeaderLetters);
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
                            ImGui.PushStyleColor(ImGuiCol.Button, gameState.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.ButtonHovered, gameState.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.ButtonActive, gameState.DaubColor);
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
                    gameState.IssuedCards[newSeed] = new PlayerData
                    {
                        PlayerName = playerName,
                        CardCount = update.newCount,
                        ShortCode = string.Empty,
                    };
                    _ = Task.Run(() =>
                        CreateShortLinkForSeedAsync(newSeed, update.newCount, NormalizeLetters(gameState.CustomHeaderLetters), playerName));
                }
            }
        }

        private void RemoveIssuedCardsForPlayer(string name)
        {
            var trimmed = NormalizePlayerName(name);
            var toRemove = gameState.IssuedCards
                .Where(entry =>
                    string.Equals(
                        NormalizePlayerName(entry.Value.PlayerName),
                        trimmed,
                        StringComparison.OrdinalIgnoreCase))
                .Select(entry => entry.Key)
                .ToList();

            foreach (var seed in toRemove)
            {
                gameState.IssuedCards.Remove(seed);
            }
        }

        private static string NormalizePlayerName(string? name)
        {
            var trimmed = (name ?? string.Empty).Trim();
            return string.IsNullOrEmpty(trimmed) ? "Guest" : trimmed;
        }

        private static string ExtractFirstLastName(string? name)
        {
            var trimmed = (name ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(trimmed))
            {
                return string.Empty;
            }

            var atIndex = trimmed.IndexOf('@');
            if (atIndex >= 0)
            {
                trimmed = trimmed[..atIndex].Trim();
            }

            var parts = trimmed
                .Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .ToArray();
            if (parts.Length >= 2)
            {
                return $"{parts[0]} {parts[1]}";
            }
            return parts.Length == 1 ? parts[0] : string.Empty;
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
            var bg = ColorToHex(gameState.BgColor);
            var card = ColorToHex(gameState.CardColor);
            var header = ColorToHex(gameState.HeaderColor);
            var text = ColorToHex(gameState.TextColor);
            var daub = ColorToHex(gameState.DaubColor);
            var ball = ColorToHex(gameState.BallColor);
            var venue = gameState.VenueName?.Trim();

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
            if (!string.IsNullOrWhiteSpace(gameState.RoomCode))
            {
                url = AppendQueryParam(url, "room", gameState.RoomCode);
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
                ["title"] = string.IsNullOrWhiteSpace(gameState.VenueName)
                    ? null
                    : gameState.VenueName.Trim(),
                ["room"] = string.IsNullOrWhiteSpace(gameState.RoomCode)
                    ? null
                    : gameState.RoomCode.Trim(),
                ["game"] = gameState.GameType,
                ["bg"] = ColorToHex(gameState.BgColor),
                ["card"] = ColorToHex(gameState.CardColor),
                ["header"] = ColorToHex(gameState.HeaderColor),
                ["text"] = ColorToHex(gameState.TextColor),
                ["daub"] = ColorToHex(gameState.DaubColor),
                ["ball"] = ColorToHex(gameState.BallColor),
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

            if (gameState.IssuedCards.TryGetValue(seed, out var data))
            {
                data.ShortCode = code;
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

        private static Vector4 ParseHexColor(JsonElement parent, string propertyName, Vector4 fallback)
        {
            if (!parent.TryGetProperty(propertyName, out var value) ||
                value.ValueKind != JsonValueKind.String)
            {
                return fallback;
            }

            return ParseHexColor(value.GetString(), fallback);
        }

        private static Vector4 ParseHexColor(string? value, Vector4 fallback)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return fallback;
            }

            var cleaned = value.Trim().TrimStart('#');
            if (cleaned.Length == 3)
            {
                cleaned = string.Concat(cleaned[0], cleaned[0], cleaned[1], cleaned[1], cleaned[2], cleaned[2]);
            }
            if (cleaned.Length != 6 ||
                !int.TryParse(cleaned, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
            {
                return fallback;
            }

            float r = ((rgb >> 16) & 0xFF) / 255f;
            float g = ((rgb >> 8) & 0xFF) / 255f;
            float b = (rgb & 0xFF) / 255f;
            return new Vector4(r, g, b, 1f);
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

        private static string FormatNumber(int value)
        {
            return value.ToString("N0", CultureInfo.InvariantCulture);
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
            var bg = ColorToHex(gameState.BgColor);
            var card = ColorToHex(gameState.CardColor);
            var header = ColorToHex(gameState.HeaderColor);
            var text = ColorToHex(gameState.TextColor);
            var daub = ColorToHex(gameState.DaubColor);
            var ball = ColorToHex(gameState.BallColor);

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
                var roomKey = configuration.RoomKey?.Trim();
                if (string.IsNullOrWhiteSpace(roomKey))
                {
                    adminRoomsStatus = "Room key is required.";
                    return;
                }

                var serverBaseUrl = GetServerBaseUrl();
                using var request = new HttpRequestMessage(
                    HttpMethod.Get,
                    $"{serverBaseUrl}/api/rooms");
                request.Headers.Add("x-room-key", roomKey);
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
                var roomKey = configuration.RoomKey?.Trim();
                if (string.IsNullOrWhiteSpace(roomKey))
                {
                    adminRoomsStatus = "Room key is required.";
                    return;
                }

                var serverBaseUrl = GetServerBaseUrl();
                var payload = JsonSerializer.Serialize(new { roomCode });
                using var request = new HttpRequestMessage(
                    HttpMethod.Post,
                    $"{serverBaseUrl}/api/rooms/close");
                request.Headers.Add("x-room-key", roomKey);
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
            if (string.IsNullOrWhiteSpace(configuration.RoomKey))
            {
                DebugChat("Room key is required to start a new room.", true);
                return;
            }

            gameState.RoomCode = Guid.NewGuid().ToString();
            gameState.CalledNumbers.Clear();
            gameState.IssuedCards.Clear();
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
            _ = Task.Run(SyncHostStateAsync);
        }

        private void StopBingo()
        {
            gameState.RoomCode = string.Empty;
            gameState.CalledNumbers.Clear();
            gameState.IssuedCards.Clear();
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
        }

        private void SelectRoom(string roomCode)
        {
            if (string.IsNullOrWhiteSpace(configuration.RoomKey))
            {
                DebugChat("Room key is required to resume a room.", true);
                return;
            }

            gameState.RoomCode = roomCode;
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

        private sealed class GameState
        {
            public string RoomCode { get; set; } = string.Empty;
            public List<int> CalledNumbers { get; set; } = new();
            public Dictionary<string, PlayerData> IssuedCards { get; set; } = new();
            public int CostPerCard { get; set; } = 0;
            public int StartingPot { get; set; } = 0;
            public float PrizePercentage { get; set; } = 0f;
            public string CustomHeaderLetters { get; set; } = "BINGO";
            public string VenueName { get; set; } = "FFXIV Bingo";
            public string GameType { get; set; } = "Single Line";
            public Vector4 BgColor { get; set; } = new(0.07f, 0.08f, 0.09f, 1.0f);
            public Vector4 CardColor { get; set; } = new(0.11f, 0.13f, 0.15f, 1.0f);
            public Vector4 HeaderColor { get; set; } = new(0.16f, 0.19f, 0.23f, 1.0f);
            public Vector4 TextColor { get; set; } = new(0.90f, 0.93f, 0.96f, 1.0f);
            public Vector4 DaubColor { get; set; } = new(0.20f, 0.82f, 0.48f, 1.0f);
            public Vector4 BallColor { get; set; } = new(0.96f, 0.96f, 0.96f, 1.0f);
        }

        private void MaybeRefreshRoomState()
        {
            if (roomStateFetchInFlight)
            {
                return;
            }

            if (string.IsNullOrWhiteSpace(gameState.RoomCode))
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
                var roomCode = Uri.EscapeDataString(gameState.RoomCode);
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

                if (updateCalledNumbers)
                {
                    if (root.TryGetProperty("calledNumbers", out var calledEl) &&
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
                        gameState.CalledNumbers = called;
                    }

                    var allowedCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    if (root.TryGetProperty("allowedCards", out var allowedEl) &&
                        allowedEl.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var seedProp in allowedEl.EnumerateObject())
                        {
                            if (seedProp.Value.TryGetInt32(out var count))
                            {
                                allowedCounts[seedProp.Name] = Math.Clamp(count, 1, 16);
                            }
                        }
                    }

                    var newPlayers = new Dictionary<string, PlayerData>(StringComparer.OrdinalIgnoreCase);
                    if (root.TryGetProperty("players", out var playersEl) &&
                        playersEl.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var seedProp in playersEl.EnumerateObject())
                        {
                            if (seedProp.Value.ValueKind != JsonValueKind.Object)
                            {
                                continue;
                            }

                            var seed = seedProp.Name;
                            var playerObj = seedProp.Value;
                            string name = playerObj.TryGetProperty("name", out var nameEl)
                                ? nameEl.GetString() ?? "Guest"
                                : "Guest";
                            int count = playerObj.TryGetProperty("count", out var countEl) &&
                                        countEl.TryGetInt32(out var parsed)
                                ? Math.Clamp(parsed, 1, 16)
                                : 1;
                            string shortCode = playerObj.TryGetProperty("shortCode", out var shortEl)
                                ? shortEl.GetString() ?? string.Empty
                                : string.Empty;

                            newPlayers[seed] = new PlayerData
                            {
                                PlayerName = NormalizePlayerName(name),
                                CardCount = count,
                                ShortCode = shortCode,
                            };
                        }
                    }

                    foreach (var entry in allowedCounts)
                    {
                        if (newPlayers.TryGetValue(entry.Key, out var data))
                        {
                            data.CardCount = entry.Value;
                        }
                        else
                        {
                            newPlayers[entry.Key] = new PlayerData
                            {
                                PlayerName = "Guest",
                                CardCount = entry.Value,
                                ShortCode = string.Empty,
                            };
                        }
                    }

                    if (newPlayers.Count > 0)
                    {
                        gameState.IssuedCards = newPlayers;
                    }
                    else if (allowedCounts.Count == 0)
                    {
                        gameState.IssuedCards.Clear();
                    }

                    if (root.TryGetProperty("costPerCard", out var costEl) &&
                        costEl.TryGetInt32(out var cost))
                    {
                        gameState.CostPerCard = Math.Max(0, cost);
                    }

                    if (root.TryGetProperty("startingPot", out var startEl) &&
                        startEl.TryGetInt32(out var startingPot))
                    {
                        gameState.StartingPot = Math.Max(0, startingPot);
                    }

                    if (root.TryGetProperty("prizePercentage", out var prizeEl) &&
                        prizeEl.TryGetDouble(out var prizePercent))
                    {
                        gameState.PrizePercentage = Math.Clamp((float)prizePercent, 0f, 100f);
                    }

                    if (root.TryGetProperty("gameType", out var gameEl) &&
                        gameEl.ValueKind == JsonValueKind.String)
                    {
                        var nextGame = gameEl.GetString();
                        if (!string.IsNullOrWhiteSpace(nextGame))
                        {
                            gameState.GameType = nextGame.Trim();
                        }
                    }

                    if (root.TryGetProperty("letters", out var lettersEl) &&
                        lettersEl.ValueKind == JsonValueKind.String)
                    {
                        gameState.CustomHeaderLetters = NormalizeLetters(lettersEl.GetString() ?? string.Empty);
                    }

                    if (root.TryGetProperty("title", out var titleEl) &&
                        titleEl.ValueKind == JsonValueKind.String)
                    {
                        gameState.VenueName = titleEl.GetString() ?? gameState.VenueName;
                    }

                    if (root.TryGetProperty("colors", out var colorsEl) &&
                        colorsEl.ValueKind == JsonValueKind.Object)
                    {
                        gameState.BgColor = ParseHexColor(colorsEl, "bg", gameState.BgColor);
                        gameState.CardColor = ParseHexColor(colorsEl, "card", gameState.CardColor);
                        gameState.HeaderColor = ParseHexColor(colorsEl, "header", gameState.HeaderColor);
                        gameState.TextColor = ParseHexColor(colorsEl, "text", gameState.TextColor);
                        gameState.DaubColor = ParseHexColor(colorsEl, "daub", gameState.DaubColor);
                        gameState.BallColor = ParseHexColor(colorsEl, "ball", gameState.BallColor);
                    }
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

        private void DrawSinglePlayerCard(string seed, int cardIndex)
        {
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
                            ImGui.PushStyleColor(ImGuiCol.Button, gameState.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.ButtonHovered, gameState.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.ButtonActive, gameState.DaubColor);
                            ImGui.PushStyleColor(ImGuiCol.Text, new Vector4(0f, 0f, 0f, 1f));
                        }

                        string label = isFree ? "FREE" : number.GetValueOrDefault().ToString();
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
