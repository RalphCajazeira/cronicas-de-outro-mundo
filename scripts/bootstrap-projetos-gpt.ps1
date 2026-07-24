[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectSlug,

    [string]$TargetRoot = (Get-Location).Path,
    [string]$RepositoryUrl = "https://github.com/RalphCajazeira/Projetos_Gpt.git",
    [string]$Branch = "main",
    [switch]$InitializeGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Comando obrigatório não encontrado: $Name"
    }
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Copy-ManagedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Arquivo de origem ausente: $Source"
    }

    Ensure-Directory -Path (Split-Path -Parent $Destination)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-ManagedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Diretório de origem ausente: $Source"
    }

    if (Test-Path -LiteralPath $Destination) {
        throw "O destino gerenciado já existe: $Destination. Use o fluxo de manutenção ou sincronização em vez do bootstrap."
    }

    Ensure-Directory -Path $Destination
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

Assert-CommandExists -Name "git"

Ensure-Directory -Path $TargetRoot
$resolvedTarget = (Resolve-Path -LiteralPath $TargetRoot).Path
$metadataPath = Join-Path $resolvedTarget ".projetos-gpt-sync.json"

if (Test-Path -LiteralPath $metadataPath) {
    throw "Esta pasta já possui uma instalação gerenciada. Use scripts/sync-projetos-gpt.ps1 ou MAINTAIN_PROJETOS_GPT.md."
}

$managedCollisionPaths = @(
    "AGENTS.md",
    "AGENTS-PROJECT.md",
    "BOOTSTRAP_PROJETO_VAZIO.md",
    "MAINTAIN_PROJETOS_GPT.md",
    "SYNC_FROM_PROJETOS_GPT.md",
    ".agents/skills",
    "docs/ai",
    "templates/eslint",
    "scripts/sync-projetos-gpt.ps1"
)

$collisions = @()
foreach ($relativePath in $managedCollisionPaths) {
    $candidate = Join-Path $resolvedTarget $relativePath
    if (Test-Path -LiteralPath $candidate) {
        $collisions += $relativePath
    }
}

if ($collisions.Count -gt 0) {
    throw "Foram encontrados caminhos gerenciados existentes: $($collisions -join ', '). Use o fluxo de manutenção completa para comparar e preservar conteúdo válido."
}

$gitDirectory = Join-Path $resolvedTarget ".git"
if (-not (Test-Path -LiteralPath $gitDirectory)) {
    if (-not $InitializeGit) {
        throw "A pasta ainda não é um repositório Git. Execute novamente com -InitializeGit ou inicialize Git manualmente."
    }

    & git -C $resolvedTarget init
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao inicializar o repositório Git local."
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("projetos-gpt-bootstrap-" + [Guid]::NewGuid().ToString("N"))

try {
    & git clone --depth 1 --branch $Branch $RepositoryUrl $tempRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao clonar $RepositoryUrl na branch $Branch."
    }

    $sourceTemplate = Join-Path $tempRoot "geral/codex/repository-template"
    $sourceProject = Join-Path $tempRoot ("projetos/" + $ProjectSlug)
    $sourceProjectChatgpt = Join-Path $sourceProject "chatgpt"
    $sourceProjectCodex = Join-Path $sourceProject "codex"

    if (-not (Test-Path -LiteralPath $sourceTemplate -PathType Container)) {
        throw "Base geral do Codex não encontrada em geral/codex/repository-template."
    }
    if (-not (Test-Path -LiteralPath $sourceProject -PathType Container)) {
        throw "Projeto específico não encontrado: projetos/$ProjectSlug"
    }
    if (-not (Test-Path -LiteralPath $sourceProjectChatgpt -PathType Container)) {
        throw "Fontes específicas do ChatGPT não encontradas: projetos/$ProjectSlug/chatgpt"
    }
    if (-not (Test-Path -LiteralPath $sourceProjectCodex -PathType Container)) {
        throw "Instruções específicas do Codex não encontradas: projetos/$ProjectSlug/codex"
    }

    Copy-ManagedFile -Source (Join-Path $sourceTemplate "AGENTS.md") -Destination (Join-Path $resolvedTarget "AGENTS.md")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "BOOTSTRAP_PROJETO_VAZIO.md") -Destination (Join-Path $resolvedTarget "BOOTSTRAP_PROJETO_VAZIO.md")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "MAINTAIN_PROJETOS_GPT.md") -Destination (Join-Path $resolvedTarget "MAINTAIN_PROJETOS_GPT.md")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "SYNC_FROM_PROJETOS_GPT.md") -Destination (Join-Path $resolvedTarget "SYNC_FROM_PROJETOS_GPT.md")

    $sourceProjectAgent = Join-Path $sourceProjectCodex "AGENTS-PROJECT.md"
    $projectAgentManaged = $false
    if (Test-Path -LiteralPath $sourceProjectAgent -PathType Leaf) {
        Copy-ManagedFile -Source $sourceProjectAgent -Destination (Join-Path $resolvedTarget "AGENTS-PROJECT.md")
        $projectAgentManaged = $true
    }

    Copy-ManagedDirectory -Source (Join-Path $sourceTemplate ".agents/skills") -Destination (Join-Path $resolvedTarget ".agents/skills")

    $targetDocs = Join-Path $resolvedTarget "docs/ai"
    Ensure-Directory -Path $targetDocs

    $managedDocFiles = @()
    Get-ChildItem -LiteralPath (Join-Path $sourceTemplate "docs/ai") -File -Filter "*.md" | ForEach-Object {
        $managedDocFiles += $_.Name
        Copy-ManagedFile -Source $_.FullName -Destination (Join-Path $targetDocs $_.Name)
    }

    $targetProjectDocs = Join-Path $targetDocs "project"
    Ensure-Directory -Path $targetProjectDocs

    $managedProjectDocFiles = @()
    Get-ChildItem -LiteralPath $sourceProjectChatgpt -File -Filter "*.md" |
        Where-Object { $_.Name -ne "README.md" } |
        ForEach-Object {
            $managedProjectDocFiles += $_.Name
            Copy-ManagedFile -Source $_.FullName -Destination (Join-Path $targetProjectDocs $_.Name)
        }

    $managedProjectCodexDocFiles = @()
    $sourceProjectCodexDocs = Join-Path $sourceProjectCodex "docs"
    if (Test-Path -LiteralPath $sourceProjectCodexDocs -PathType Container) {
        $targetProjectCodexDocs = Join-Path $targetProjectDocs "codex"
        Ensure-Directory -Path $targetProjectCodexDocs

        Get-ChildItem -LiteralPath $sourceProjectCodexDocs -File -Filter "*.md" |
            Where-Object { $_.Name -ne "README.md" } |
            ForEach-Object {
                $managedProjectCodexDocFiles += $_.Name
                Copy-ManagedFile -Source $_.FullName -Destination (Join-Path $targetProjectCodexDocs $_.Name)
            }
    }

    Copy-ManagedDirectory -Source (Join-Path $sourceTemplate "templates/eslint") -Destination (Join-Path $resolvedTarget "templates/eslint")

    $targetScripts = Join-Path $resolvedTarget "scripts"
    Ensure-Directory -Path $targetScripts
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "scripts/bootstrap-projetos-gpt.ps1") -Destination (Join-Path $targetScripts "bootstrap-projetos-gpt.ps1")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "scripts/sync-projetos-gpt.ps1") -Destination (Join-Path $targetScripts "sync-projetos-gpt.ps1")

    $sourceCommit = (& git -C $tempRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceCommit)) {
        throw "Não foi possível determinar o commit de origem."
    }

    $managedPaths = @(
        "AGENTS.md",
        "BOOTSTRAP_PROJETO_VAZIO.md",
        "MAINTAIN_PROJETOS_GPT.md",
        "SYNC_FROM_PROJETOS_GPT.md",
        ".agents/skills/",
        "docs/ai/*.md",
        "docs/ai/project/*.md",
        "templates/eslint/",
        "scripts/bootstrap-projetos-gpt.ps1",
        "scripts/sync-projetos-gpt.ps1"
    )

    if ($projectAgentManaged) {
        $managedPaths += "AGENTS-PROJECT.md"
    }
    if ($managedProjectCodexDocFiles.Count -gt 0) {
        $managedPaths += "docs/ai/project/codex/*.md"
    }

    $metadata = [ordered]@{
        schemaVersion = 1
        installationMode = "bootstrap"
        sourceRepository = $RepositoryUrl
        sourceBranch = $Branch
        sourceCommit = $sourceCommit
        projectSlug = $ProjectSlug
        syncedAtUtc = [DateTime]::UtcNow.ToString("o")
        managedPaths = $managedPaths
        managedDocFiles = @($managedDocFiles | Sort-Object)
        projectAgentManaged = $projectAgentManaged
        managedProjectDocFiles = @($managedProjectDocFiles | Sort-Object)
        managedProjectCodexDocFiles = @($managedProjectCodexDocFiles | Sort-Object)
        preservedPaths = @(
            "backend/",
            "frontend/",
            "prisma/",
            "infra/",
            "arquivos fora do manifesto gerenciado"
        )
    }

    $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataPath -Encoding UTF8

    Write-Host "Bootstrap concluído."
    Write-Host "Origem: $sourceCommit"
    Write-Host "Projeto: $ProjectSlug"
    Write-Host "Nenhum commit ou push foi realizado."
    Write-Host "Revise agora: git status --short"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}