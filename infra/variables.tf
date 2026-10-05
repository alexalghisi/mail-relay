variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "mail-relay"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "api_image" {
  description = "Image for the API, the TypeScript worker and the webhook dispatcher."
  type        = string
}

variable "go_worker_image" {
  description = "Image for the Go delivery worker."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener. Without one the ALB only listens on HTTP."
  type        = string
  default     = ""
}

variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_min_count" {
  type    = number
  default = 2
}

variable "worker_max_count" {
  type    = number
  default = 20
}

variable "worker_target_queue_depth" {
  description = "Queued deliveries per worker task that autoscaling aims for."
  type        = number
  default     = 2000
}

variable "go_worker_desired_count" {
  description = "Go workers drain the same queue as the TypeScript workers; run either or both."
  type        = number
  default     = 0
}

variable "smtp_relay_host" {
  description = "Outbound SMTP relay the workers deliver through."
  type        = string
}

variable "smtp_relay_port" {
  type    = number
  default = 25
}

variable "alarm_email" {
  description = "Where alarm notifications go. Empty disables the subscription."
  type        = string
  default     = ""
}

variable "queue_age_alarm_seconds" {
  description = "Alarm when the oldest due delivery has waited longer than this."
  type        = number
  default     = 300
}
