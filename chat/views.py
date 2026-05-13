from django.shortcuts import render

def index(request):
    """Renders the study planner homepage."""
    return render(request, 'chat/index.html')
