# LSDC2 stack for AWS

> [!CAUTION]
> Although deploying the stack and running the Discord bot is virtually free,
> this stack gives many, non-free privileges to the bot (see [IAM roles](#iam-roles)
> section). You <ins>will</ins> be charged when you provision game servers.

This project is part of the LSDC2 stack. *LSDC* stands for *"Le serveur des copains"*
which can be translated to *"The Pals' Server"*. It is an AWS hosted Discord bot to
provision short lived Spot game server.

This project is the CDK stack powering the Discord bot. The simplified architecture
of the stack is illustrated below.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="doc/stack-dark.svg">
  <img alt="LSDC2 stack high level architecture" src="doc/stack-light.svg">
</picture>

## Prerequisites

* An AWS account.
* CDK v2 installed and configured.
* The [LSDC2 Discord bot](https://github.com/Meuna/lsdc2-discord-bot) binaries compiled locally.
* A [Discord bot](https://discord.com/developers).

## Usage

1. Run `scripts/secrets.sh` and fill the secrets of your Discord bot.

```console
$ scripts/secrets.sh
Name of the parameter ? [/lsdc2/discord-secrets] 
Bot public key (General Information panel): ...
Bot client ID (OAuth2/General panel): ...
Bot client secret (OAuth2/General panel):
Bot token (Bot panel):
```

The SecureString `/lsdc2/discord-secrets` should be created in your account SSM
Parameter Store.

2. Ensure that the context variables `discordBotBackendPath` and `discordBotFrontendPath`
in the `cdk.context.json` file point to local LSDC2 Discord binaries.

By default, the binaries are looked in the `../lsdc2-discord-bot/` relative path,
as follow:

```
├─ lsdc2-cdk/
|  └─ README  <- your are here
└─ lsdc2-discord-bot/
   ├─ backend.zip
   └─ frontend.zip
```

3. Run `cdk deploy` and follow the CDK prompt. At the end of the provisioning, note
the `Lsdc2CdkStack.botUrl` output.

```console
$ cdk deploy

...

 ✅  Lsdc2CdkStack

✨  Deployment time: 2m 31.08s

Outputs:
Lsdc2CdkStack.botUrl = https:// ... .lambda-url.{{ region }}.on.aws   <- Lambda URL here
Stack ARN:
arn:aws:cloudformation:{{ region }}:{{ account }}:stack/Lsdc2CdkStack/ ...

✨  Total time: 2m 37.32s

```

4. Configure the Discord bot "Interactions Endpoint URL" (General Information panel)
with the Lmabda URL from step 3.

## IAM roles

The stack gives ample privileges to the bot to allow server provisioning. This
section list the IAM privileges bestowed upon the bot.

* **CloudWatch Logs role**: standard logging role for Lambda

```json
{
  "Action": [
    "logs:CreateLogGroup",
    "logs:CreateLogStream",
    "logs:PutLogEvents"
  ],
  "Resource": "arn:aws:logs:{{ region }}:{{ account }}:*",
  "Effect": "Allow"
}
```

* **DynamoDB role**: the tables hold the state of the bot

```json
{
  "Action": [
    "dynamodb:DeleteItem",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Scan"
  ],
  "Resource": [
    "arn:aws:dynamodb:{{ region }}:{{ account }}:table/Lsdc2CdkStack-guild ... ",
    "arn:aws:dynamodb:{{ region }}:{{ account }}:table/Lsdc2CdkStack-instance ... ",
    "arn:aws:dynamodb:{{ region }}:{{ account }}:table/Lsdc2CdkStack-server ... ",
    "arn:aws:dynamodb:{{ region }}:{{ account }}:table/Lsdc2CdkStack-spec ... ",
    "arn:aws:dynamodb:{{ region }}:{{ account }}:table/Lsdc2CdkStack-tier ... "
  ],
  "Effect": "Allow"
}
```

* **S3 role**: enable the bot to download/upload game files

```json
{
  "Action": [
    "s3:GetObject",
    "s3:PutObject"
  ],
  "Resource": "arn:aws:s3:::lsdc2cdkstack-savegames ... /*",
  "Effect": "Allow"
}
```

* **IAM role**: allows the bot to assign their roles to ECS tasks and EC2 instances

```json
{
  "Action": "iam:PassRole",
  "Resource": [
    "arn:aws:iam::{{ account }}:role/Lsdc2CdkStack-ec2Role ... ",
    "arn:aws:iam::{{ account }}:role/Lsdc2CdkStack-executionRole ... ",
    "arn:aws:iam::{{ account }}:role/Lsdc2CdkStack-taskContainerRole ... "
  ],
  "Effect": "Allow"
}
```

* **SQS role**: the frontend Lambda send jobs to the backend Lambda via an SQS queue

```json
{
  "Action": [
    "sqs:ReceiveMessage",
    "sqs:SendMessage"
  ],
  "Resource": "arn:aws:sqs:{{ region}}:{{ account }}:Lsdc2CdkStack-discordBotQueue ... ",
  "Effect": "Allow"
}
```

* **SSM role**: the bot credentials are stored in an SSM parameter. Furthermore,
in order to cleanly stop EC2 instances, the bot needs to be able to signal the
ldcs2-pilot process to terminate. This is done with a SSM command. Since the
instance resources are dynamic, the bot can send command to any (`"*"`) resource.

```json
{
  "Action": "ssm:GetParameter",
  "Resource": "arn:aws:ssm:{{ region}}:{{ account }}:parameter/lsdc2/discord-secrets",
  "Effect": "Allow"
},
{
  "Action": [
    "ssm:GetCommandInvocation",
    "ssm:ListCommandInvocations",
    "ssm:SendCommand"
  ],
  "Resource": "*",
  "Effect": "Allow"
}
```

* **EC2 role**: the bot needs many permissions to be able to launch EC2 instances.
The detailed rational is provided as inline comments.

```json
// Description permissions
{
  "Action": [
    "ec2:DescribeImages",
    "ec2:DescribeInstances",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSpotPriceHistory",
    "ec2:DescribeSubnets"
  ],
  "Resource": "*",
  "Effect": "Allow"
},

// The bot create a security group for each game type, with ingress tailored to its needed port
{
  "Action": [
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:CreateSecurityGroup",
    "ec2:CreateTags",
    "ec2:DeleteSecurityGroup"
  ],
  "Resource": [
    "arn:aws:ec2:{{ region}}:{{ account }}:security-group-rule/*",
    "arn:aws:ec2:{{ region}}:{{ account }}:security-group/*",
    "arn:aws:ec2:{{ region}}:{{ account }}:vpc/vpc- ... "
  ],
  "Effect": "Allow"
},

// Permissions needed to launch EC2 instances
{
  "Action": [
    "ec2:CreateTags",
    "ec2:ModifyVolume",
    "ec2:RunInstances"
  ],
  "Resource": [
    "arn:aws:ec2:{{ region}}:{{ account }}:instance/*",
    "arn:aws:ec2:{{ region}}:{{ account }}:network-interface/*",
    "arn:aws:ec2:{{ region}}:{{ account }}:security-group/*",
    "arn:aws:ec2:{{ region}}:{{ account }}:volume/*",
    "arn:aws:ec2:{{ region}}::image/*",
    "arn:aws:ec2:{{ region}}:{{ account }}:subnet/subnet- ... ",
    "arn:aws:ec2:{{ region}}:{{ account }}:subnet/subnet- ... ",
    "arn:aws:ec2:{{ region}}:{{ account }}:subnet/subnet- ... "
  ],
  "Effect": "Allow"
}
```

* **ECS role**: the bot needs to create ECS tasks for each game, tailored to its
needed port. The bot then needs to start and stop tasks.

```json
{
  "Action": [
    "ecs:DeregisterTaskDefinition",
    "ecs:ListTaskDefinitions"
  ],
  "Resource": "*",
  "Effect": "Allow"
},
{
  "Action": [
    "ecs:DescribeTasks",
    "ecs:RegisterTaskDefinition",
    "ecs:RunTask",
    "ecs:StopTask",
    "ecs:TagResource"
  ],
  "Resource": [
    "arn:aws:ecs:{{ region}}:{{ account }}:task-definition/Lsdc2CdkStack-cluster ... *",
    "arn:aws:ecs:{{ region}}:{{ account }}:task/Lsdc2CdkStack-cluster ... *"
  ],
  "Effect": "Allow"
}
```