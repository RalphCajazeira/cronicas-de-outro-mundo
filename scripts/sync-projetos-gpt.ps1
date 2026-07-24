[CmdletBinding()]
param(
    [string]$TargetRoot = (Get-Location).Path,
    [string]$ProjectSlug = "",
    [string]$RepositoryUrl = "https://github.com/RalphCajazeira/Projetos_Gpt.git",
    [string]$Branch = "main",
    [switch]$AllowDirty
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

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Arquivo de origem ausente: $Source"
    }

    Ensure-Directory -Path (Split-Path -Parent $Destination)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-MetadataArray {
    param(
        [Parameter(Mandatory = $true)]$Metadata,
        [Parameter(Mandatory = $true)][string]$PropertyName
    )

    if ($Metadata.PSObject.Properties.Name -contains $PropertyName) {
        return @($Metadata.$PropertyName)
    }

    return @()
}

Assert-CommandExists -Name "git"

$resolvedTarget = (Resolve-Path -LiteralPath $TargetRoot).Path
$gitDirectory = Join-Path $resolvedTarget ".git"
$metadataPath = Join-Path $resolvedTarget ".projetos-gpt-sync.json"

if (-not (Test-Path -LiteralPath $gitDirectory)) {
    throw "TargetRoot não parece ser a raiz de um repositório Git: $resolvedTarget"
}

$workingTreeStatus = & git -C $resolvedTarget status --porcelain
if ($LASTEXITCODE -ne 0) {
    throw "Não foi possível consultar o estado Git do repositório alvo."
}

if ($workingTreeStatus -and -not $AllowDirty) {
    throw "A working tree não está limpa. Faça commit/stash ou use -AllowDirty somente com autorização explícita."
}

$previousManagedDocFiles = @()
$previousManagedProjectDocFiles = @()
$previousManagedProjectCodexDocFiles = @()
$previousProjectAgentManaged = $false
$previousProjectSlug = ""

if (Test-Path -LiteralPath $metadataPath) {
    try {
        $previousMetadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        $previousManagedDocFiles = Get-MetadataArray -Metadata $previousMetadata -PropertyName "managedDocFiles"
        $previousManagedProjectDocFiles = Get-MetadataArray -Metadata $previousMetadata -PropertyName "managedProjectDocFiles"
        $previousManagedProjectCodexDocFiles = Get-MetadataArray -Metadata $previousMetadata -PropertyName "managedProjectCodexDocFiles"

        if ($previousMetadata.PSObject.Properties.Name -contains "projectAgentManaged") {
            $previousProjectAgentManaged = [bool]$previousMetadata.projectAgentManaged
        }
        if (($previousMetadata.PSObject.Properties.Name -contains "projectSlug") -and $null -ne $previousMetadata.projectSlug) {
            $previousProjectSlug = [string]$previousMetadata.projectSlug
        }
    }
    catch {
        throw "O arquivo .projetos-gpt-sync.json existe, mas não pôde ser lido com segurança: $($_.Exception.Message)"
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("projetos-gpt-sync-" + [Guid]::NewGuid().ToString("N"))

try {
    & git clone --depth 1 --branch $Branch $RepositoryUrl $tempRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao clonar $RepositoryUrl na branch $Branch."
    }

    $sourceTemplate = Join-Path $tempRoot "geral/codex/repository-template"
    if (-not (Test-Path -LiteralPath $sourceTemplate)) {
        throw "Base do Codex não encontrada em geral/codex/repository-template."
    }

    Copy-ManagedFile -Source (Join-Path $sourceTemplate "AGENTS.md") -Destination (Join-Path $resolvedTarget "AGENTS.md")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "BOOTSTRAP_PROJETO_VAZIO.md") -Destination (Join-Path $resolvedTarget "BOOTSTRAP_PROJETO_VAZIO.md")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "MAINTAIN_PROJETOS_GPT.md") -Destination (Join-Path $resolvedTarget "MAINTAIN_PROJETOS_GPT.md")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "SYNC_FROM_PROJETOS_GPT.md") -Destination (Join-Path $resolvedTarget "SYNC_FROM_PROJETOS_GPT.md")

    $sourceSkills = Join-Path $sourceTemplate ".agents/skills"
    $targetSkills = Join-Path $resolvedTarget ".agents/skills"
    if (Test-Path -LiteralPath $targetSkills) {
        Remove-Item -LiteralPath $targetSkills -Recurse -Force
    }
    Ensure-Directory -Path (Split-Path -Parent $targetSkills)
    Copy-Item -LiteralPath $sourceSkills -Destination $targetSkills -Recurse -Force

    # Documentos gerais gerenciados em docs/ai/*.md.
    $sourceDocs = Join-Path $sourceTemplate "docs/ai"
    $targetDocs = Join-Path $resolvedTarget "docs/ai"
    Ensure-Directory -Path $targetDocs
    Ensure-Directory -Path (Join-Path $targetDocs "project")

    foreach ($fileName in $previousManagedDocFiles) {
        $oldManagedFile = Join-Path $targetDocs $fileName
        if (Test-Path -LiteralPath $oldManagedFile) {
            Remove-Item -LiteralPath $oldManagedFile -Force
        }
    }

    $currentManagedDocFiles = @()
    Get-ChildItem -LiteralPath $sourceDocs -File -Filter "*.md" | ForEach-Object {
        $currentManagedDocFiles += $_.Name
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDocs $_.Name) -Force
    }

    $sourceTemplates = Join-Path $sourceTemplate "templates/eslint"
    $targetTemplates = Join-Path $resolvedTarget "templates/eslint"
    if (Test-Path -LiteralPath $targetTemplates) {
        Remove-Item -LiteralPath $targetTemplates -Recurse -Force
    }
    Ensure-Directory -Path (Split-Path -Parent $targetTemplates)
    Copy-Item -LiteralPath $sourceTemplates -Destination $targetTemplates -Recurse -Force

    $targetScripts = Join-Path $resolvedTarget "scripts"
    Ensure-Directory -Path $targetScripts
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "scripts/bootstrap-projetos-gpt.ps1") -Destination (Join-Path $targetScripts "bootstrap-projetos-gpt.ps1")
    Copy-ManagedFile -Source (Join-Path $sourceTemplate "scripts/sync-projetos-gpt.ps1") -Destination (Join-Path $targetScripts "sync-projetos-gpt.ps1")

    $hasRequestedProject = -not [string]::IsNullOrWhiteSpace($ProjectSlug)
    $effectiveProjectSlug = if ($hasRequestedProject) { $ProjectSlug } else { $previousProjectSlug }
    if ($hasRequestedProject) {
        $currentManagedProjectDocFiles = @()
        $currentManagedProjectCodexDocFiles = @()
        $projectAgentManaged = $false
    }
    else {
        $currentManagedProjectDocFiles = @($previousManagedProjectDocFiles)
        $currentManagedProjectCodexDocFiles = @($previousManagedProjectCodexDocFiles)
        $projectAgentManaged = $previousProjectAgentManaged
    }

    if ($hasRequestedProject) {
        $sourceProject = Join-Path $tempRoot ("projetos/" + $ProjectSlug)
        $sourceProjectChatgpt = Join-Path $sourceProject "chatgpt"
        $sourceProjectCodex = Join-Path $sourceProject "codex"

        if (-not (Test-Path -LiteralPath $sourceProject)) {
            throw "Projeto específico não encontrado: projetos/$ProjectSlug"
        }
        if (-not (Test-Path -LiteralPath $sourceProjectChatgpt)) {
            throw "Fontes específicas do ChatGPT não encontradas: projetos/$ProjectSlug/chatgpt"
        }
        if (-not (Test-Path -LiteralPath $sourceProjectCodex)) {
            throw "Instruções específicas do Codex não encontradas: projetos/$ProjectSlug/codex"
        }

        # Instrução específica do Codex na raiz.
        $sourceProjectAgent = Join-Path $sourceProjectCodex "AGENTS-PROJECT.md"
        $targetProjectAgent = Join-Path $resolvedTarget "AGENTS-PROJECT.md"

        if (Test-Path -LiteralPath $sourceProjectAgent) {
            Copy-ManagedFile -Source $sourceProjectAgent -Destination $targetProjectAgent
            $projectAgentManaged = $true
        }
        elseif ($previousProjectAgentManaged -and (Test-Path -LiteralPath $targetProjectAgent)) {
            Remove-Item -LiteralPath $targetProjectAgent -Force
        }

        # Fontes específicas compartilhadas com o ChatGPT.
        $targetProjectDocs = Join-Path $targetDocs "project"
        Ensure-Directory -Path $targetProjectDocs

        $legacyProjectFiles = @(
            "PROJECT_SOURCE.md",
            "PROJECT_RULES.md",
            "CURRENT_STATE.md",
            "ROADMAP.md",
            "DECISIONS.md",
            "CODEX_RULES.md",
            "HANDOFF.md"
        )

        $projectFilesToRemove = @($previousManagedProjectDocFiles + $legacyProjectFiles | Sort-Object -Unique)
        foreach ($fileName in $projectFilesToRemove) {
            $oldManagedFile = Join-Path $targetProjectDocs $fileName
            if (Test-Path -LiteralPath $oldManagedFile) {
                Remove-Item -LiteralPath $oldManagedFile -Force
            }
        }

        Get-ChildItem -LiteralPath $sourceProjectChatgpt -File -Filter "*.md" |
            Where-Object { $_.Name -ne "README.md" } |
            ForEach-Object {
                $currentManagedProjectDocFiles += $_.Name
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetProjectDocs $_.Name) -Force
            }

        # Documentação opcional exclusiva do Codex.
        $sourceProjectCodexDocs = Join-Path $sourceProjectCodex "docs"
        $targetProjectCodexDocs = Join-Path $targetProjectDocs "codex"

        foreach ($fileName in $previousManagedProjectCodexDocFiles) {
            $oldManagedFile = Join-Path $targetProjectCodexDocs $fileName
            if (Test-Path -LiteralPath $oldManagedFile) {
                Remove-Item -LiteralPath $oldManagedFile -Force
            }
        }

        if (Test-Path -LiteralPath $sourceProjectCodexDocs) {
            Ensure-Directory -Path $targetProjectCodexDocs
            Get-ChildItem -LiteralPath $sourceProjectCodexDocs -File -Filter "*.md" |
                Where-Object { $_.Name -ne "README.md" } |
                ForEach-Object {
                    $currentManagedProjectCodexDocFiles += $_.Name
                    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetProjectCodexDocs $_.Name) -Force
                }
        }
    }

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
        "templates/eslint/",
        "scripts/bootstrap-projetos-gpt.ps1",
        "scripts/sync-projetos-gpt.ps1"
    )

    if (-not [string]::IsNullOrWhiteSpace($effectiveProjectSlug)) {
        $managedPaths += "AGENTS-PROJECT.md"
        $managedPaths += "docs/ai/project/*.md"
        $managedPaths += "docs/ai/project/codex/*.md"
    }

    $metadata = [ordered]@{
        sourceRepository = $RepositoryUrl
        sourceBranch = $Branch
        sourceCommit = $sourceCommit
        projectSlug = if ([string]::IsNullOrWhiteSpace($effectiveProjectSlug)) { $null } else { $effectiveProjectSlug }
        syncedAtUtc = [DateTime]::UtcNow.ToString("o")
        managedPaths = $managedPaths
        managedDocFiles = @($currentManagedDocFiles | Sort-Object)
        projectAgentManaged = $projectAgentManaged
        managedProjectDocFiles = @($currentManagedProjectDocFiles | Sort-Object)
        managedProjectCodexDocFiles = @($currentManagedProjectCodexDocFiles | Sort-Object)
        preservedPaths = @(
            "backend/",
            "frontend/",
            "prisma/",
            "infra/",
            "arquivos fora do manifesto gerenciado"
        )
    }

    $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataPath -Encoding UTF8

    Write-Host "Sincronização concluída."
    Write-Host "Origem: $sourceCommit"
    Write-Host "Projeto: $(if ([string]::IsNullOrWhiteSpace($effectiveProjectSlug)) { 'somente base geral' } else { $effectiveProjectSlug })"
    Write-Host "Revise agora: git status --short"
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
