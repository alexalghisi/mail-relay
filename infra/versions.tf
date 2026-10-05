terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Configure per environment, e.g.
  # terraform init -backend-config="bucket=..." -backend-config="key=mail-relay/prod.tfstate"
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "mail-relay"
      Environment = var.environment
    }
  }
}
