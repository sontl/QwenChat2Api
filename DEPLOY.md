# Zeabur Deployment Guide

This guide will help you deploy the Qwen API proxy service to the Zeabur platform.

## 📋 Prerequisites

1. A [Zeabur](https://zeabur.com) account
2. A GitHub account (for code repository)
3. Qwen Cookie and Token

## 🚀 Deployment Steps

### Method 1: Deploy via GitHub Repository (Recommended)

#### 1. Prepare Code Repository

Ensure your code has been pushed to the GitHub repository:

```bash
git add .
git commit -m "Prepare for Zeabur deployment"
git push origin main
```

#### 2. Create Project in Zeabur

1. Login to [Zeabur](https://zeabur.com)
2. Click "New Project" to create a new project
3. Select "Import from GitHub" and authorize access to your GitHub repository
4. Select your `QwenChat2Api` repository

#### 3. Configure Environment Variables

Add the following environment variables in the Zeabur project settings:

**Required Environment Variables:**

```
COOKIE=Your Qwen Cookie value
QWEN_TOKEN=Your Qwen Token (optional, will be automatically fetched from Cookie)
```

**Optional Environment Variables:**

```
API_KEY=sk-aaaa-bbbb-cccc-dddd           # API Key (optional)
SERVER_MODE=true                         # Server-side mode (default: true)
DEBUG_MODE=false                         # Debug mode (default: false)
SERVER_PORT=8000                         # Service port (default: 8000, Zeabur will automatically set PORT)
VISION_FALLBACK_MODEL=qwen3-vl-plus      # Vision fallback model (default: qwen3-vl-plus)
AUTO_REFRESH_TOKEN=true                  # Automatically refresh Token (default: true)
TOKEN_REFRESH_INTERVAL_HOURS=24          # Token refresh interval (default: 24 hours)
```

#### 4. Get Cookie and Token

##### Method A: Get from Browser

1. Open browser and visit https://chat.qwen.ai
2. Login to your account
3. Open Developer Tools (F12)
4. Switch to Network tab
5. Refresh the page or send a message
6. Click any request and find the Cookie value in Headers
7. Copy the complete Cookie value (including all key-value pairs)

##### Method B: Manual Configuration File Editing

1. Create `cookie.txt` file locally and paste the Cookie value
2. Run the service (it will automatically get Token from Cookie):
   ```bash
   npm start
   ```
3. Copy the `QWEN_TOKEN` value from `config.json`
4. Set the Cookie and Token as Zeabur environment variables separately

#### 5. Deploy

1. On the Zeabur project page, click the "Deploy" button
2. Zeabur will automatically detect the Node.js project and start building
3. Wait for the build to complete (usually takes 2-5 minutes)
4. After successful deployment, you will get a public URL (e.g., `https://your-project.zeabur.app`)

### Method 2: Deploy via Zeabur CLI

```bash
# Install Zeabur CLI
npm install -g @zeabur/cli

# Login
zeabur login

# Deploy
zeabur deploy
```

## 🔧 Configuration Description

### Environment Variable Priority

The project supports two configuration methods:

1. **Environment Variables** (recommended for cloud deployment)
   - Prioritize environment variables
   - Suitable for cloud platforms like Zeabur, Vercel

2. **Configuration Files** (suitable for local development)
   - `config.json` - Application configuration
   - `cookie.txt` - Cookie storage

### Important Configuration Items

- **COOKIE**: Qwen Cookie, used to automatically get and refresh Tokens
- **QWEN_TOKEN**: Qwen authentication Token (optional, will be automatically acquired)
- **API_KEY**: Key to protect API endpoints (optional)
- **SERVER_PORT**: Service port (Zeabur will automatically set the `PORT` environment variable)

## 📝 Verify Deployment

After deployment, access the following endpoints to verify the service:

### 1. Health Check

```bash
curl https://your-project.zeabur.app/health
```

Should return service status information.

### 2. Get Model List

```bash
curl https://your-project.zeabur.app/v1/models \
  -H "Authorization: Bearer your_api_key"
```

### 3. Test Chat

```bash
curl -X POST https://your-project.zeabur.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_api_key" \
  -d '{
    "model": "qwen3-max",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

## 🔄 Update Deployment

### Update Code

```bash
git add .
git commit -m "Update code"
git push origin main
```

Zeabur will automatically detect the code update and redeploy.

### Update Environment Variables

1. Modify environment variables in the Zeabur project settings
2. Click "Redeploy" to redeploy

## 🐛 Troubleshooting

### 1. Service Cannot Start

**Issue**: Service cannot start after deployment

**Solutions**:
- Check if environment variables are set correctly
- View Zeabur's log output
- Confirm if `COOKIE` and `QWEN_TOKEN` are valid

### 2. Token Expiration

**Issue**: Request failure due to token expiration

**Solutions**:
- Ensure `COOKIE` environment variable is set
- Service will automatically refresh Token from Cookie (if `AUTO_REFRESH_TOKEN=true`)
- Or manually update the `QWEN_TOKEN` environment variable

### 3. 404 Error

**Issue**: Access endpoint returns 404

**Solutions**:
- Check if URL is correct
- Confirm service has been successfully deployed
- View service logs

### 4. Authentication Failure

**Issue**: Returns 401 authentication failure

**Solutions**:
- Check if `API_KEY` is set correctly
- Confirm Authorization format in request headers is correct
- If in server-side mode, ensure `SERVER_MODE=true`

## 📊 Monitoring and Logs

### View Logs

On the Zeabur project page, click your service to view:
- Real-time log output
- Build logs
- Error logs

### Health Check

Regularly access the `/health` endpoint to check service status:

```bash
curl https://your-project.zeabur.app/health
```

Return information includes:
- Service status
- Token validity
- Token remaining time
- Configuration information

## 🔐 Security Recommendations

1. **Protect API_KEY**: Don't commit API_KEY to the code repository
2. **Regular Cookie Updates**: Cookies may expire, regularly update environment variables
3. **Use HTTPS**: Zeabur provides HTTPS by default
4. **Restrict Access**: Consider adding IP whitelist or using Zeabur's access control features

## 📚 Related Links

- [Zeabur Documentation](https://zeabur.com/docs)
- [Project README](./README.md)
- [Qwen Official Website](https://chat.qwen.ai)

## 💡 Tips

1. **First Deployment**: It's recommended to not set `QWEN_TOKEN` initially, let the service automatically get it from `COOKIE`
2. **Auto Refresh**: Enable `AUTO_REFRESH_TOKEN=true` to automatically maintain the Token
3. **Debug Mode**: Temporarily enable `DEBUG_MODE=true` when encountering issues to view detailed logs
4. **Port Configuration**: Zeabur will automatically set the `PORT` environment variable, no need to configure manually

## 🎉 Done!

After successful deployment, your Qwen API proxy service can be accessed via the public URL provided by Zeabur.

If you have any issues, please check Zeabur's logs or contact support.

