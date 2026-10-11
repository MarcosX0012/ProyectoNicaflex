<#
  Control del cluster PostgreSQL local de desarrollo.

  Por que existe esto: en esta maquina no hay Docker ni Redis, y el
  PostgreSQL del sistema requiere privilegios de administrador para
  reconfigurar su autenticacion. En lugar de depender de eso, el
  proyecto trae su PROPIO cluster en el puerto 5433, dentro de .devdb/.

  Esa decision tambien simplifica la arquitectura: no hay Redis, asi
  que las colas de trabajo usan pg-boss (Postgres) y el tiempo real
  entre instancias usa LISTEN/NOTIFY de Postgres. Menos piezas que
  pueden fallar, mismo resultado.

  Uso:
    powershell -File scripts/db.ps1 start|stop|status|reset|password
#>

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'reset', 'password')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# ── Localizacion de los binarios de PostgreSQL ────────────────────
# Busca la instalacion mas reciente en las rutas estandar de Windows.
function Get-PgBin {
  $roots = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending

  foreach ($root in $roots) {
    $candidate = Join-Path $root.FullName 'bin'
    if (Test-Path (Join-Path $candidate 'pg_ctl.exe')) { return $candidate }
  }

  # Alternativa: PostgreSQL en el PATH.
  if (Get-Command pg_ctl -ErrorAction SilentlyContinue) {
    return (Split-Path (Get-Command pg_ctl).Source)
  }

  throw 'No se encontro PostgreSQL. Instala PostgreSQL 14+ o agrega su bin al PATH.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot '.devdb'
$logFile = Join-Path $dataDir 'server.log'
$port = 5433

# ── Autenticacion ─────────────────────────────────────────────────
# El cluster se inicializa con `trust` y es EXCLUSIVAMENTE local
# (listen_addresses = 127.0.0.1). El rol es de la aplicacion, no
# superusuario con datos real: ahi no hay nada que proteger.
#
# Si el .env define una URL propia (por ejemplo el Postgres del
# sistema), `start` no hace nada porque esa base ya esta en pie.
$env:PGUSER    = 'hossana'
$env:PGDATABASE = 'hossana_dev'
$env:PGHOST    = '127.0.0.1'
$env:PGPORT    = "$port"

# Resuelve (y cachea) la carpeta de binarios. Se llama desde varias
# funciones, incluidas las de solo comprobacion, asi que no puede
# depender de que otra funcion haya pasado antes.
function Resolve-PgBin {
  if ($script:PgBin) { return $script:PgBin }
  $script:PgBin = Get-PgBin
  return $script:PgBin
}

# Comprueba con una consulta real, no solo con el socket: `pg_isready`
# puede responder "accepting connections" con un postmaster sano que
# despues se cae al no poder arrancar un backend. Ademas, este script
# se lanza desde terminales con un PATH enorme (Java, SQL Server, Git,
# PHP, dotnet...), y esa contaminacion es justo lo que provoca el
# fallo de DLL que tumbaba el cluster. Ver Start-Cluster.
function Test-Running {
  $psql = Join-Path (Resolve-PgBin) 'psql'
  try {
    $result = & $psql -h 127.0.0.1 -p $port -U $env:PGUSER -d hossana_dev `
      -tAc 'SELECT 1' 2>$null
    return ($LASTEXITCODE -eq 0 -and "$result".Trim() -eq '1')
  } catch {
    return $false
  }
}

function Initialize-Cluster {
  if (Test-Path (Join-Path $dataDir 'PG_VERSION')) { return }

  Write-Host 'Inicializando cluster PostgreSQL de desarrollo...' -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

  & (Join-Path $script:PgBin 'initdb') `
    -D $dataDir `
    -U $env:PGUSER `
    --auth=trust `
    --encoding=UTF8 `
    --locale=C

  if ($LASTEXITCODE -ne 0) { throw 'initdb fallo' }
}

# Borra `postmaster.pid` SOLO si esta realmente obsoleto.
#
# Borrarlo a ciegas es peligroso: si el servidor esta corriendo,
# Postgres ve desaparecer su fichero de bloqueo y se apaga de
# inmediato ("data directory lock file is invalid"), tumbandose a si
# mismo en pleno trabajo. El fichero solo contiene basura cuando el
# proceso que lo creo ya no existe.
function Remove-StalePidFile {
  $pidFile = Join-Path $dataDir 'postmaster.pid'
  if (-not (Test-Path $pidFile)) { return }

  $postmasterPid = Get-Content $pidFile -TotalCount 1 -ErrorAction SilentlyContinue
  if ($postmasterPid -and (Get-Process -Id ([int]$postmasterPid) -ErrorAction SilentlyContinue)) {
    Write-Host "  postmaster.pid pertenece al proceso $postmasterPid (vivo). No se toca." -ForegroundColor DarkGray
    return
  }

  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host '  postmaster.pid obsoleto eliminado.' -ForegroundColor DarkGray
}

# Espera a que el cluster responda consultas de verdad, no solo que
# tenga el socket abierto. El margen es amplio a proposito: en esta
# maquina el antivirus retrasa el arranque del log del servidor unos 30
# segundos y la recuperacion tras cierre no limpio se suma.
function Wait-Ready {
  param([int]$timeoutSeconds = 120)

  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $attempt = 0

  while ((Get-Date) -lt $deadline) {
    $attempt++
    if (Test-Running) { return $true }
    if ($attempt % 5 -eq 1) {
      Write-Host "  esperando al cluster... ($attempt)" -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 2
  }

  return $false
}

function Start-Cluster {
  if (Test-Running) {
    Write-Host "PostgreSQL ya esta escuchando en el puerto $port." -ForegroundColor DarkGray
    return
  }

  $bin = Resolve-PgBin
  Initialize-Cluster

  Remove-StalePidFile

  # ── PATH limpio para el servidor ─────────────────────────────
  # Este es el punto mas importante del script en Windows.
  #
  # El postmaster lanza un proceso NUEVO de postgres.exe por cada
  # conexion (no hay fork como en Unix). Cada proceso hijo hereda el
  # entorno del postmaster, incluida su variable PATH.
  #
  # Si ese PATH esta contaminado con las carpetas de otras
  # instalaciones (SQL Server, PHP, Git, dotnet, Java, NVIDIA...), la
  # resolucion de DLL del hijo puede encontrar una version distinta de
  # una libreria compartida y fallar al inicializarla. El sintoma es
  # `client backend was terminated by exception 0xC0000142`
  # (STATUS_DLL_INIT_FAILED): el postmaster arranca bien, acepta
  # conexiones, y se cae entero en cuanto alguien se conecta.
  #
  # Por eso el servidor se lanza con un PATH minimo (bin + lib +
  # Windows) en vez de con el del terminal que ejecuta este script.
  $libDir = Join-Path (Split-Path $bin -Parent) 'lib'
  $cleanPath = "$bin;$libDir;C:\Windows\System32;C:\Windows"

  Write-Host 'Iniciando cluster...' -ForegroundColor Cyan

  # autovacuum=off: es una base de desarrollo y se queda encendida sin
  # supervision. En un despliegue real autovacuum debe ir activado.
  #
  # El arranque se delega en cmd.exe porque hay que fijar el PATH solo
  # para este proceso hijo, sin tocar el del script ni el del usuario.
  # Se pasan rutas absolutas porque cmd.exe puede cambiar el directorio
  # actual antes de ejecutar.
  $pgCtl = Join-Path $bin 'pg_ctl.exe'
  $logAbs = Join-Path $dataDir 'server.log'
  $bootLog = Join-Path $dataDir 'boot.log'
  $bootErr = Join-Path $dataDir 'boot.err'

  # Tres detalles que parecen menores pero son la diferencia entre
  # funcionar y colgarse:
  #
  #  1. `start "" /B` desacopla pg_ctl del proceso de este script. Sin
  #     eso, si el terminal que ejecuto `npm run db:start` se cierra a
  #     mitad de la espera, el postmaster queda huerfano en un estado
  #     en el que ya no es capaz de lanzar backends: acepta el socket,
  #     pero cada conexion lo tumba con STATUS_DLL_INIT_FAILED.
  #
  #  2. La salida de cmd.exe se redirige a un FICHERO, nunca a la
  #     tuberia de PowerShell. `cmd | Out-Null` deja que pg_ctl y el
  #     postmaster hereden los extremos de escritura de esa tuberia, y
  #     PowerShell no devuelve el control hasta que la tuberia se
  #     cierra: el script se queda bloqueado hasta que mate la tarea
  #     aunque el servidor arrancara perfectamente.
  #
  #  3. Se delega en cmd.exe porque hay que fijar el PATH solo para ese
  #     proceso hijo, sin tocar el del script ni el del usuario.
  $arguments = "/c set `"PATH=$cleanPath`" && start `"`" /B `"$pgCtl`" -D `"$dataDir`" -l `"$logAbs`" -o `"-p $port -c listen_addresses=127.0.0.1 -c autovacuum=off`" --no-wait start"

  Start-Process -FilePath 'cmd.exe' -ArgumentList $arguments `
    -WindowStyle Hidden -RedirectStandardOutput $bootLog -RedirectStandardError $bootErr | Out-Null

  # El arranque no es instantaneo. En esta maquina el antivirus
  # bloquea el log del servidor unos 30 segundos y la recuperacion tras
  # un cierre no limpio se suma a eso, asi que el primer intento de
  # conectar suele caer en "database system is starting up". Se espera
  # de verdad a que responda una consulta real.
  if (-not (Wait-Ready)) {
    Write-Host 'El postmaster arranco pero no termino de recuperar. Revisa el log:' -ForegroundColor Red
    Get-Content $logAbs -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed }
    throw "El cluster no respondio consultas reales en 120 s"
  }

  # Orden importante: primero se crean las bases y DESPUES se degrada
  # el rol. Al reves, el ALTER deja a hossana sin CREATEDB y el
  # CREATE DATABASE de un cluster recien inicializado fallaria con
  # permission denied. Ademas, en un arranque posterior el ALTER ya
  # no tiene permisos (el rol ya fue degradado) y ese error no debe
  # tumbar el arranque del cluster.
  foreach ($db in @('hossana_dev', 'hossana_test')) {
    try {
      $exists = & (Join-Path $bin 'psql') -h 127.0.0.1 -p $port -U $env:PGUSER -d postgres `
        -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" 2>$null
      if ("$exists".Trim() -ne '1') {
        & (Join-Path $bin 'psql') -h 127.0.0.1 -p $port -U $env:PGUSER -d postgres `
          -c "CREATE DATABASE $db;" 2>$null | Out-Null
        Write-Host "  Base creada: $db" -ForegroundColor DarkGray
      }
    } catch {
      Write-Host "  No se pudo verificar/crear ${db}: $_" -ForegroundColor DarkYellow
    }
  }

  try {
    & (Join-Path $bin 'psql') -h 127.0.0.1 -p $port -U $env:PGUSER -d postgres `
      -c 'ALTER ROLE hossana NOSUPERUSER NOCREATEDB NOCREATEROLE;' 2>$null | Out-Null
  } catch {
    Write-Host '  (rol hossana ya restringido en un arranque anterior)' -ForegroundColor DarkGray
  }

  Write-Host "PostgreSQL listo en 127.0.0.1:$port" -ForegroundColor Green
}

function Stop-Cluster {
  $bin = Resolve-PgBin
  if (-not (Test-Running)) {
    Write-Host 'El cluster no esta corriendo.' -ForegroundColor DarkGray
    return
  }
  & (Join-Path $bin 'pg_ctl') -D $dataDir -w -m fast stop | Out-Null
  Write-Host 'PostgreSQL detenido.' -ForegroundColor Yellow
}

function Reset-Cluster {
  Write-Host 'ADVERTENCIA: se borraran TODOS los datos de hossana_dev y hossana_test.' -ForegroundColor Red
  $confirmation = Read-Host 'Escribe SI para confirmar'
  if ($confirmation -ne 'SI') {
    Write-Host 'Cancelado.' -ForegroundColor DarkGray
    return
  }

  Stop-Cluster
  if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }
  Start-Cluster
  Push-Location $projectRoot
  try {
    npx prisma migrate deploy
  } finally {
    Pop-Location
  }
  Write-Host 'Cluster reinicializado y migraciones aplicadas.' -ForegroundColor Green
}

switch ($Action) {
  'start'    { Start-Cluster }
  'stop'     { Stop-Cluster }
  'reset'    { Reset-Cluster }
  'password' { Write-Host 'El cluster de desarrollo usa trust local; no hay password que cambiar.' }
  'status' {
    $bin = Resolve-PgBin
    if (Test-Running) {
      Write-Host "PostgreSQL ACTIVO en 127.0.0.1:$port" -ForegroundColor Green
      & (Join-Path $bin 'psql') -h 127.0.0.1 -p $port -U $env:PGUSER -d hossana_dev `
        -tAc "SELECT 'Envios: ' || count(*) FROM shipments" 2>$null
    } else {
      Write-Host 'PostgreSQL DETENIDO. Ejecuta: npm run db:start' -ForegroundColor Yellow
    }
  }
}