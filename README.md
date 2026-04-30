# Local Model Assessment Operator

A tool for the automated evaluation of local Large Language Models (LLMs) running via Ollama. It allows you to benchmark performance (tokens/sec) and intellectual capabilities (quality of answers) side-by-side, using another LLM as an objective "judge".


## Prerequisites

Before you begin, ensure you have the following installed:

1.  **Python 3.10+**
2.  **Ollama**: The application must be installed and running. You can download it from [ollama.com](https://ollama.com/).
3.  **At least two LLMs** downloaded via Ollama (one to act as a judge, one as a candidate).
    ```bash
    # Example:
    ollama pull gemma3:270m-it-qat
    ollama pull qwen3.5:0.8b
    ```

## Installation & Setup

Follow these steps to get the operator running locally.

### Step 0: Clone & Create Virtual Environment

First, clone the repository and navigate into the directory. Then, create and activate a Python virtual environment.

```bash
# Clone the repository
git clone https://your-git-repository/local-model-assessor.git
cd local-model-assessor

# Create a virtual environment
python -m venv venv

# Activate the environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
venv\Scripts\activate
```

### Step 1: Install Dependencies

Install all the required Python libraries using the `requirements.txt` file.

```bash
pip install -r requirements.txt
```

### Step 2: Configure Environment

Copy the example environment file and edit it if your Ollama instance runs on a different address or port.

```bash
# On macOS/Linux:
cp .env.example .env

# On Windows:
copy .env.example .env
```
Now, open the `.env` file and adjust the `OLLAMA_BASE_URL` if necessary.

## Running the Application

With the setup complete, start the Flask web server.

```bash
python app.py
```

The server will start, and you can access the dashboard by opening your web browser to:
**http://127.0.0.1:5000**

---

## Cleanup

To stop the server, press `Ctrl+C` in the terminal where it is running.

To exit the Python virtual environment, simply run:

```bash
deactivate
```

To completely remove the application, you can delete the project folder.