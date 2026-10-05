resource "aws_ecs_cluster" "main" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["api", "worker", "go-worker", "webhooks", "migrate"])
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_db_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "read_db_secret" {
  name   = "read-db-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_db_secret.json
}

# The services need no AWS API access: metrics leave through the logs as
# CloudWatch embedded metric format.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

locals {
  # The password is injected separately as PGPASSWORD, which both node-postgres
  # and pgx read when the URL has none.
  common_environment = [
    { name = "DATABASE_URL", value = "postgres://mailrelay@${aws_db_instance.main.address}:5432/mailrelay?sslmode=require" },
    { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379" },
    { name = "SMTP_HOST", value = var.smtp_relay_host },
    { name = "SMTP_PORT", value = tostring(var.smtp_relay_port) },
    { name = "LEASE_SECONDS", value = "60" },
  ]
  common_secrets = [
    { name = "PGPASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
  ]

  services = {
    api = {
      image   = var.api_image
      command = ["node", "src/cli.ts", "api"]
      cpu     = 512
      memory  = 1024
      extra   = []
      # Fargate's default is 30 s; in-flight requests finish well within it.
      stop_timeout = 30
    }
    worker = {
      image        = var.api_image
      command      = ["node", "src/cli.ts", "worker"]
      cpu          = 512
      memory       = 1024
      extra        = [{ name = "EMF_METRICS", value = "1" }]
      stop_timeout = 120
    }
    go-worker = {
      image        = var.go_worker_image
      command      = []
      cpu          = 256
      memory       = 512
      extra        = []
      stop_timeout = 120
    }
    webhooks = {
      image        = var.api_image
      command      = ["node", "src/cli.ts", "webhooks"]
      cpu          = 256
      memory       = 512
      extra        = []
      stop_timeout = 60
    }
    migrate = {
      image        = var.api_image
      command      = ["node", "src/cli.ts", "migrate"]
      cpu          = 256
      memory       = 512
      extra        = []
      stop_timeout = 30
    }
  }
}

resource "aws_ecs_task_definition" "service" {
  # The Go worker is optional; without an image it isn't registered.
  for_each                 = { for name, svc in local.services : name => svc if svc.image != "" }
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = each.value.image
    command   = length(each.value.command) > 0 ? each.value.command : null
    essential = true
    # Time between SIGTERM and SIGKILL. Workers use it to finish sends that
    # are already talking to a remote MTA.
    stopTimeout  = each.value.stop_timeout
    environment  = concat(local.common_environment, each.value.extra)
    secrets      = local.common_secrets
    portMappings = each.key == "api" ? [{ containerPort = 3000, protocol = "tcp" }] : []
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

locals {
  long_running = merge(
    {
      api      = var.api_desired_count
      worker   = var.worker_min_count
      webhooks = 2
    },
    var.go_worker_image == "" ? {} : { go-worker = var.go_worker_desired_count },
  )
}

resource "aws_ecs_service" "service" {
  for_each        = local.long_running
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.value
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = each.key == "api" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = "api"
      container_port   = 3000
    }
  }

  # Counts are set on creation. After that the autoscaler owns the worker
  # count, and a deploy must not reset it to the minimum.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
}
